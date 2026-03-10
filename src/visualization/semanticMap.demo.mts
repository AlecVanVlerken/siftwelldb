import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { collectDocuments } from './collectDocuments.mjs';
import { computeTfIdf } from './vectorize.mjs';
import { reduceTo2D } from './pca.mjs';
import { renderMap } from './renderMap.mjs';
import type { MapPoint } from './renderMap.mjs';
import { join } from 'node:path';

// Sample dataset: world cities with continent, population and language.
// Documents that share continent/language will cluster together on the map.
const CITIES = [
  { id: 'Paris', country: 'France', continent: 'Europe', population: 2161000, language: 'French' },
  { id: 'Lyon', country: 'France', continent: 'Europe', population: 522000, language: 'French' },
  { id: 'London', country: 'UK', continent: 'Europe', population: 8982000, language: 'English' },
  { id: 'Berlin', country: 'Germany', continent: 'Europe', population: 3645000, language: 'German' },
  { id: 'Munich', country: 'Germany', continent: 'Europe', population: 1488000, language: 'German' },
  { id: 'Rome', country: 'Italy', continent: 'Europe', population: 2873000, language: 'Italian' },
  { id: 'Milan', country: 'Italy', continent: 'Europe', population: 1352000, language: 'Italian' },
  { id: 'Madrid', country: 'Spain', continent: 'Europe', population: 3223000, language: 'Spanish' },
  { id: 'Tokyo', country: 'Japan', continent: 'Asia', population: 13960000, language: 'Japanese' },
  { id: 'Osaka', country: 'Japan', continent: 'Asia', population: 2691000, language: 'Japanese' },
  { id: 'Beijing', country: 'China', continent: 'Asia', population: 21540000, language: 'Mandarin' },
  { id: 'Shanghai', country: 'China', continent: 'Asia', population: 24280000, language: 'Mandarin' },
  { id: 'Mumbai', country: 'India', continent: 'Asia', population: 12442000, language: 'Hindi' },
  { id: 'Delhi', country: 'India', continent: 'Asia', population: 32941000, language: 'Hindi' },
  { id: 'Seoul', country: 'South Korea', continent: 'Asia', population: 9776000, language: 'Korean' },
  { id: 'Bangkok', country: 'Thailand', continent: 'Asia', population: 10539000, language: 'Thai' },
  { id: 'New York', country: 'USA', continent: 'America', population: 8336000, language: 'English' },
  { id: 'Los Angeles', country: 'USA', continent: 'America', population: 3979000, language: 'English' },
  { id: 'Chicago', country: 'USA', continent: 'America', population: 2696000, language: 'English' },
  { id: 'Sao Paulo', country: 'Brazil', continent: 'America', population: 12325000, language: 'Portuguese' },
  { id: 'Rio de Janeiro', country: 'Brazil', continent: 'America', population: 6748000, language: 'Portuguese' },
  { id: 'Mexico City', country: 'Mexico', continent: 'America', population: 9209000, language: 'Spanish' },
  { id: 'Buenos Aires', country: 'Argentina', continent: 'America', population: 2891000, language: 'Spanish' },
  { id: 'Cairo', country: 'Egypt', continent: 'Africa', population: 10107000, language: 'Arabic' },
  { id: 'Lagos', country: 'Nigeria', continent: 'Africa', population: 14800000, language: 'English' },
  { id: 'Nairobi', country: 'Kenya', continent: 'Africa', population: 4397000, language: 'Swahili' },
  { id: 'Sydney', country: 'Australia', continent: 'Oceania', population: 5312000, language: 'English' },
  { id: 'Auckland', country: 'New Zealand', continent: 'Oceania', population: 1614000, language: 'English' },
];

async function main(): Promise<void> {
  console.log('Setting up database...');
  const dataFile = new MockFile(4 * 1024 * 1024);
  const logFile = new MockFile(4096);
  const db = await SimpleDbms.create(dataFile, logFile);

  for (const city of CITIES) {
    await db.insertDocument('cities', JSON.stringify(city));
  }
  await db.commit();
  console.log(`Inserted ${CITIES.length} documents into collection "cities".`);

  // Step 1 — collect all documents from the database
  console.log('Collecting documents...');
  const docs = await collectDocuments(db, 'cities');

  // Step 2 — convert each document to a TF-IDF vector
  console.log('Computing TF-IDF vectors...');
  const vectors = computeTfIdf(docs);

  // Step 3 — reduce to 2D with PCA
  console.log('Reducing to 2D with PCA...');
  const points2d = reduceTo2D(vectors);

  // Step 4 — build the map point list
  const mapPoints: MapPoint[] = docs.map((doc, i) => ({
    x: points2d[i].x,
    y: points2d[i].y,
    id: String(doc['id']),
    label: String(doc['id']),
    fields: Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'id')),
  }));

  // Step 5 — write the interactive HTML file
  const outputPath = join(process.cwd(), 'map.html');
  renderMap(mapPoints, outputPath);

  console.log(`\nDone! Open this file in your browser:`);
  console.log(`  ${outputPath}`);

  await db.close();
}

main().catch(console.error);
