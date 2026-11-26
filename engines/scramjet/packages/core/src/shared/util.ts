import {
	Array_from,
	atob,
	btoa,
	TextDecoder_decode,
	TextEncoder_encode,
	String_fromCharCode,
	String_fromCodePoint,
} from "@/shared/snapshot";

function bytesToBase64Fallback(bytes: Uint8Array): string {
	const binString = Array_from(bytes, (byte) =>
		String_fromCodePoint(byte)
	).join("");

	return btoa(binString);
}

const bytesToBase64Native: ((this: Uint8Array) => string) | undefined = (
	Uint8Array.prototype as any
).toBase64;

export const bytesToBase64: (bytes: Uint8Array) => string =
	typeof bytesToBase64Native === "function"
		? (bytes) => bytesToBase64Native.call(bytes)
		: bytesToBase64Fallback;

export function base64Encode(text: string) {
	return btoa(
		TextEncoder_encode(text)
			.reduce(
				(data, byte) => (data.push(String_fromCharCode(byte)), data),
				[] as any
			)
			.join("")
	);
}

// vssh fork: o inverso do `bytesToBase64(TextEncoder_encode(texto))`. O `atob` sozinho devolve os
// bytes UTF-8 um por caractere, e um script com acento ou emoji voltava ao site com o texto trocado
// e mais comprido.
export function base64Decode(base64: string): string {
	const bin = atob(base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

	return TextDecoder_decode(bytes);
}
