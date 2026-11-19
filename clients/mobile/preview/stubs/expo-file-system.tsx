export class File { uri = ""; exists = false; constructor(..._: unknown[]) {} create() {} write() {} delete() {} static downloadFileAsync = async () => new File(); }
export class Directory { uri = ""; exists = true; constructor(..._: unknown[]) {} create() {} }
export const Paths = { cache: new Directory(), document: new Directory() };
