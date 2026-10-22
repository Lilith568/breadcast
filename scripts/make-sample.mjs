// Regenerates sample-bakery.csv (synthetic data) deterministically.
import fs from 'node:fs';
import { syntheticHistory, toCSV, FIELDS } from '../forecast.mjs';
fs.writeFileSync(new URL('../sample-bakery.csv', import.meta.url), `${toCSV(syntheticHistory(), FIELDS)}\n`);
console.log('wrote sample-bakery.csv');
