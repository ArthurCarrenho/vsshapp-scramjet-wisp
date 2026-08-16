/**
 * @fileoverview
 * Validates the packages structure with the expected bundles and some core type definition files.
 * This is meant to be run in CI, but you can run it locally too after executing `pnpm prepack` if you want to test before committing.
 */

import test from "ava";
import { glob } from "glob";
import { existsSync, readFileSync } from "node:fs";

/**
 * Expected distribution files for Scramjet's bundles.
 * All JS files listed must have corresponding source maps.
 * These aren't globs.
 */
const EXPECTED_CORE_DIST_FILES = [
	"packages/core/dist/scramjet.js",
	"packages/core/dist/scramjet.mjs",
	"packages/core/dist/scramjet_bundled.js",
	"packages/core/dist/scramjet_bundled.mjs",
	"packages/core/dist/scramjet.wasm",
];

/**
 * Required type definition files and directories.
 * These aren't going to be all, because the modules update quite often, but the entry points and basic structure will be validatedl
 */
const EXPECTED_TYPE_FILES = [
	"packages/core/dist/types/**/*.d.ts",
	"packages/core/dist/types/index.d.ts",
	"packages/core/lib/index.d.ts",
];

/**
 * Validates that all required distribution files exist in the package.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("Package contains all required distribution files", async (t) => {
	const missingFiles = [];

	for (const filePath of EXPECTED_CORE_DIST_FILES) {
		if (!existsSync(filePath)) {
			missingFiles.push(filePath);
		}
	}

	t.deepEqual(
		missingFiles,
		[],
		`Missing required distribution files: ${missingFiles.join(", ")}`
	);
});

/**
 * Validates that all required JS files have their corresponding source maps.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("All required JS bundles have corresponding source maps", async (t) => {
	const jsFiles = EXPECTED_CORE_DIST_FILES.filter((file) =>
		file.endsWith(".js")
	);
	const missingMaps = [];

	for (const jsFile of jsFiles) {
		const mapFile = `${jsFile}.map`;
		if (!existsSync(mapFile)) {
			missingMaps.push(mapFile);
		}
	}

	t.deepEqual(
		missingMaps,
		[],
		`Missing source map files: ${missingMaps.join(", ")}`
	);
});

/**
 * Validates that core type definition are included in the package.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("Package contains required type definitions", async (t) => {
	const missingTypeGlobs = [];

	for (const glob_ of EXPECTED_TYPE_FILES) {
		const matches = await glob(glob_);
		if (matches.length === 0) {
			missingTypeGlobs.push(glob_);
		}
	}

	t.deepEqual(
		missingTypeGlobs,
		[],
		`No type definition files found for globs: ${missingTypeGlobs.join(", ")}`
	);
});

/**
 * Validates the expected distribution format with globs for the package structure.
 * This serves as a last check for the basic structure of the package.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("Package structure is valid for distribution", async (t) => {
	const distFiles = await glob("packages/core/dist/**/*");
	const libFiles = await glob("packages/core/lib/**/*");

	t.true(distFiles.length > 0, "Distribution directory should contain files");
	t.true(libFiles.length > 0, "Library directory should contain files");

	const hasJsFiles = distFiles.some((file) => file.endsWith(".js"));
	const hasWasmFile = distFiles.some((file) => file.endsWith(".wasm"));
	const hasTypeFiles = libFiles.some((file) => file.endsWith(".d.ts"));

	t.true(hasJsFiles, "Distribution should contain JS files");
	t.true(hasWasmFile, "Distribution should contain WASM file");
	t.true(hasTypeFiles, "Library should contain core type definition files");
});

/**
 * The rewriter renames `location` to `globals.templocid` in destructuring TARGETS —
 * `({location} = x)`, `[location] = a`, `for (location of …)` — and never declares it: there is no
 * program-level hoist, and the emit is a bare `Ty::TempVar => LL::replace(templocid)`.
 *
 * Sloppy mode turns that into an implicit global and the code runs. Strict mode does not, and every
 * ES module is strict, so an ESM bundle doing `({ location } = …)` dies with
 * `ReferenceError: $scramjet$temploc is not defined`. `wrap.ts` closes that by declaring the id as
 * a WRITABLE global property, which makes the reference resolvable again.
 *
 * The guard is on the built bundle rather than the source because the failure only exists after the
 * bundle runs, and because "the block is still in wrap.ts" is not the same claim as "the shipped
 * bundle still installs it". `writable` is measured too: a non-writable property would turn the
 * ReferenceError into a TypeError — a different crash, not a fix.
 *
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("Built bundle declares the rewriter's location temp id as a writable global", async (t) => {
	for (const bundle of ["packages/core/dist/scramjet.js", "packages/core/dist/scramjet.mjs"]) {
		const src = readFileSync(bundle, "utf8");

		// One occurrence is the config literal (`templocid:"$scramjet$temploc"`). The install in
		// wrap.ts is a second one — counting survives minification, which mangles locals but not
		// the property name.
		const occurrences = src.split("templocid").length - 1;
		t.true(
			occurrences >= 2,
			`${bundle}: the temp id is declared in the config but never installed on the global — ` +
				`strict-mode code doing \`({location} = x)\` will throw ReferenceError`
		);

		const install = src.lastIndexOf("globals.templocid");
		t.true(install !== -1, `${bundle}: nothing reads globals.templocid`);
		t.regex(
			src.slice(install, install + 200),
			/writable\s*:\s*(!0|true)/,
			`${bundle}: the temp id is installed but not writable — the rewritten assignment to it ` +
				`would throw TypeError instead of running`
		);
	}
});
