declare module 'pdfjs-dist/build/pdf.min.mjs' {
  export const GlobalWorkerOptions: { workerSrc: string }
  export function getDocument(src: {
    data: ArrayBuffer | Uint8Array
  }): { promise: Promise<unknown> }
}
