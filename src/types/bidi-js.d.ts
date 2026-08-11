declare module "bidi-js" {
    interface EmbeddingLevels {
        levels: Uint8Array;
        paragraphs: { start: number; end: number; level: number }[];
    }

    interface Bidi {
        getEmbeddingLevels(text: string, direction?: "ltr" | "rtl"): EmbeddingLevels;
        getReorderedString(text: string, embeddingLevels: EmbeddingLevels): string;
    }

    export default function bidiFactory(): Bidi;
}