declare const ARGV: string[];
declare const global: any;
declare const imports: any;
declare function print(...args: any[]): void;
declare function printerr(...args: any[]): void;

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: ArrayBuffer | Uint8Array): string;
}

declare class TextEncoder {
  constructor();
  encode(input?: string): Uint8Array;
}
