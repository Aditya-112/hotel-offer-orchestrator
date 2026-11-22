import { runInNewContext } from 'node:vm';
import { expect } from 'chai';
import { loadValidatedCollection } from './postman-tools.mjs';

const collection = await loadValidatedCollection();
const baseUrl = process.env.POSTMAN_BASE_URL ?? collection.variable.find(variable => variable.key === 'baseUrl').value;
let assertions = 0;
for (const item of collection.item) {
  const url = item.request.url.replace('{{baseUrl}}', baseUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
  const body = await response.json();
  const pm = {
    response: { code: response.status, json: () => body },
    expect,
    test(name, check) { check(); assertions++; console.info(`PASS ${item.name}: ${name}`); }
  };
  for (const event of item.event ?? []) {
    if (event.listen === 'test') runInNewContext(event.script.exec.join('\n'), { pm }, { timeout: 1000 });
  }
}
console.info(`${collection.item.length} requests and ${assertions} collection assertions passed.`);
