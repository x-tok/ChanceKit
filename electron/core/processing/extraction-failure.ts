import type { ActivitySource } from '../../../src/schedule';
export class ExtractionFailure extends Error {
  constructor(message: string, readonly materials: ActivitySource['materials'] = []) { super(message); }
}
