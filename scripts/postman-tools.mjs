import { readFile } from 'node:fs/promises';
import Ajv from 'ajv-draft-04';

export async function loadValidatedCollection() {
  const collection = JSON.parse(await readFile(new URL('../postman/hotel-offer-orchestrator.postman_collection.json', import.meta.url), 'utf8'));
  const schema = JSON.parse(await readFile(new URL('../postman/collection-v2.1.schema.json', import.meta.url), 'utf8'));
  const validator = new Ajv({ strict: false, validateFormats: false, allErrors: true });
  const validate = validator.compile(schema);
  if (!validate(collection)) throw new Error(JSON.stringify(validate.errors));
  return collection;
}
