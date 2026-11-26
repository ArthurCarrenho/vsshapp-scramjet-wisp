export const CONTROLLERFRAME = Symbol.for("controller frame handle");

// vssh fork: o nome que o motor deu a um frame sem nome. O núcleo o esconde do `window.name` da
// página (ver `core/src/client/dom/name.ts`), que num navegador começa vazio. O registro é o do
// `Symbol.for`, e o núcleo pede o mesmo símbolo sem depender deste pacote.
export const NOMEGERADO = Symbol.for("scramjet frame generated name");
