import { SimpleDbms } from '../dbms/simpledbms.mjs';
import { MockFile } from '../core/mockfile.mjs';
import { collectDocuments } from './collectDocuments.mjs';
import { computeTfIdf } from './vectorize.mjs';
import { reduceTo2D } from './pca.mjs';
import { renderMap } from './renderMap.mjs';
import type { MapPoint } from './renderMap.mjs';
import type { RawDocument } from './collectDocuments.mjs';
import { join } from 'node:path';

// ── Cities ─────────────────────────────────────────────────────────────────
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

// ── Famous figures ─────────────────────────────────────────────────────────
// Fields are intentionally different from cities: profession, nationality, era, field.
// Shared values (e.g. "French", "German", "India") create gravity toward related cities.
// imageUrl uses ui-avatars.com which generates reliable, CORS-friendly letter avatars.
const FIGURES = [
  {
    id: 'Napoleon Bonaparte',
    nationality: 'French',
    profession: 'military leader',
    field: 'politics',
    era: '19th century',
    born: 'France',
    imageUrl: 'https://ui-avatars.com/api/?name=Napoleon+Bonaparte&size=64&background=8B0000&color=fff&bold=true',
  },
  {
    id: 'Albert Einstein',
    nationality: 'German',
    profession: 'physicist',
    field: 'science',
    era: '20th century',
    born: 'Germany',
    imageUrl: 'https://ui-avatars.com/api/?name=Albert+Einstein&size=64&background=1a3c6e&color=fff&bold=true',
  },
  {
    id: 'Wolfgang Amadeus Mozart',
    nationality: 'Austrian',
    profession: 'composer',
    field: 'music',
    era: '18th century',
    born: 'Austria',
    imageUrl: 'https://ui-avatars.com/api/?name=Mozart&size=64&background=6a0dad&color=fff&bold=true',
  },
  {
    id: 'Leonardo da Vinci',
    nationality: 'Italian',
    profession: 'artist inventor',
    field: 'art science',
    era: '15th century',
    born: 'Italy',
    imageUrl: 'https://ui-avatars.com/api/?name=Leonardo+Vinci&size=64&background=8B6914&color=fff&bold=true',
  },
  {
    id: 'Cleopatra',
    nationality: 'Egyptian',
    profession: 'pharaoh',
    field: 'politics',
    era: '1st century BC',
    born: 'Egypt',
    imageUrl: 'https://ui-avatars.com/api/?name=Cleopatra&size=64&background=c49a00&color=fff&bold=true',
  },
  {
    id: 'Mahatma Gandhi',
    nationality: 'Indian',
    profession: 'independence leader',
    field: 'politics',
    era: '20th century',
    born: 'India',
    imageUrl: 'https://ui-avatars.com/api/?name=Mahatma+Gandhi&size=64&background=e65c00&color=fff&bold=true',
  },
  {
    id: 'Martin Luther King Jr',
    nationality: 'American',
    profession: 'civil rights leader',
    field: 'politics',
    era: '20th century',
    born: 'USA',
    imageUrl: 'https://ui-avatars.com/api/?name=Martin+Luther+King&size=64&background=2e7d32&color=fff&bold=true',
  },
  {
    id: 'Confucius',
    nationality: 'Chinese',
    profession: 'philosopher',
    field: 'philosophy',
    era: '5th century BC',
    born: 'China',
    imageUrl: 'https://ui-avatars.com/api/?name=Confucius&size=64&background=b71c1c&color=fff&bold=true',
  },
  {
    id: 'Socrates',
    nationality: 'Greek',
    profession: 'philosopher',
    field: 'philosophy',
    era: '5th century BC',
    born: 'Greece',
    imageUrl: 'https://ui-avatars.com/api/?name=Socrates&size=64&background=0277bd&color=fff&bold=true',
  },
  {
    id: 'Simon Bolivar',
    nationality: 'Venezuelan',
    profession: 'liberator',
    field: 'politics',
    era: '19th century',
    born: 'Venezuela',
    imageUrl: 'https://ui-avatars.com/api/?name=Simon+Bolivar&size=64&background=558b2f&color=fff&bold=true',
  },
];

// ── World landmarks ────────────────────────────────────────────────────────
// Completely different fields from cities (no language/population) and figures
// (no profession/era), but shares country/continent so they cluster on the PCA map
// near their related cities and figures.
const LANDMARKS = [
  { id: 'Eiffel Tower', country: 'France', continent: 'Europe', built: 1889, type: 'manmade', imageUrl: 'https://ui-avatars.com/api/?name=Eiffel+Tower&size=64&background=4a4a8a&color=fff&bold=true' },
  { id: 'Colosseum', country: 'Italy', continent: 'Europe', built: 80, type: 'ancient', imageUrl: 'https://ui-avatars.com/api/?name=Colosseum&size=64&background=8a6a2a&color=fff&bold=true' },
  { id: 'Sagrada Familia', country: 'Spain', continent: 'Europe', built: 1882, type: 'manmade', imageUrl: 'https://ui-avatars.com/api/?name=Sagrada+Familia&size=64&background=6a2a8a&color=fff&bold=true' },
  { id: 'Great Wall', country: 'China', continent: 'Asia', built: 700, type: 'ancient', imageUrl: 'https://ui-avatars.com/api/?name=Great+Wall&size=64&background=8a2a2a&color=fff&bold=true' },
  { id: 'Taj Mahal', country: 'India', continent: 'Asia', built: 1643, type: 'ancient', imageUrl: 'https://ui-avatars.com/api/?name=Taj+Mahal&size=64&background=2a6a8a&color=fff&bold=true' },
  { id: 'Angkor Wat', country: 'Cambodia', continent: 'Asia', built: 1150, type: 'ancient', imageUrl: 'https://ui-avatars.com/api/?name=Angkor+Wat&size=64&background=4a8a2a&color=fff&bold=true' },
  { id: 'Pyramids of Giza', country: 'Egypt', continent: 'Africa', built: -2560, type: 'ancient', imageUrl: 'https://ui-avatars.com/api/?name=Pyramids+Giza&size=64&background=8a7a2a&color=fff&bold=true' },
  { id: 'Statue of Liberty', country: 'USA', continent: 'America', built: 1886, type: 'manmade', imageUrl: 'https://ui-avatars.com/api/?name=Statue+Liberty&size=64&background=2a8a7a&color=fff&bold=true' },
  { id: 'Machu Picchu', country: 'Peru', continent: 'America', built: 1450, type: 'ancient', imageUrl: 'https://ui-avatars.com/api/?name=Machu+Picchu&size=64&background=6a8a2a&color=fff&bold=true' },
  { id: 'Sydney Opera House', country: 'Australia', continent: 'Oceania', built: 1973, type: 'manmade', imageUrl: 'https://ui-avatars.com/api/?name=Sydney+Opera&size=64&background=2a4a8a&color=fff&bold=true' },
];

async function main(): Promise<void> {
  console.log('Setting up database...');
  const dataFile = new MockFile(12 * 1024 * 1024);
  const logFile = new MockFile(4096);
  const db = await SimpleDbms.create(dataFile, logFile);

  // Insert cities
  for (const city of CITIES) {
    await db.insertDocument('cities', JSON.stringify(city));
  }

  // Insert figures — strip imageUrl before storing (it's not a document field)
  for (const figure of FIGURES) {
    const doc = Object.fromEntries(Object.entries(figure).filter(([k]) => k !== 'imageUrl'));
    await db.insertDocument('figures', JSON.stringify(doc));
  }

  // Insert landmarks — strip imageUrl before storing
  for (const landmark of LANDMARKS) {
    const doc = Object.fromEntries(Object.entries(landmark).filter(([k]) => k !== 'imageUrl'));
    await db.insertDocument('landmarks', JSON.stringify(doc));
  }

  await db.commit();
  console.log(`Inserted ${CITIES.length} cities, ${FIGURES.length} figures, ${LANDMARKS.length} landmarks.`);

  // ── Collect from all three collections ───────────────────────────────────
  console.log('Collecting documents...');
  const cityDocs = await collectDocuments(db, 'cities');
  const figureDocs = await collectDocuments(db, 'figures');
  const landmarkDocs = await collectDocuments(db, 'landmarks');

  // Build a lookup so we can attach imageUrl after vectorization
  const imageUrlById = new Map<string, string>([
    ...FIGURES.map((f): [string, string] => [f.id, f.imageUrl]),
    ...LANDMARKS.map((l): [string, string] => [l.id, l.imageUrl]),
  ]);

  // Merge all documents — TF-IDF finds shared vocabulary across all three types
  const allDocs: RawDocument[] = [...cityDocs, ...figureDocs, ...landmarkDocs];

  // ── Vectorize, reduce, render ─────────────────────────────────────────────
  console.log('Computing TF-IDF vectors...');
  const vectors = computeTfIdf(allDocs);

  console.log('Reducing to 2D with PCA...');
  const points2d = reduceTo2D(vectors);

  const mapPoints: MapPoint[] = allDocs.map((doc, i) => {
    const id = String(doc['id']);
    return {
      x: points2d[i].x,
      y: points2d[i].y,
      id,
      label: id,
      fields: Object.fromEntries(Object.entries(doc).filter(([k]) => k !== 'id')),
      imageUrl: imageUrlById.get(id),
    };
  });

  const outputPath = join(process.cwd(), 'map.html');
  renderMap(mapPoints, outputPath);

  console.log(`\nTotal: ${allDocs.length} documents across 3 collections.`);
  console.log(`\nDone! Open this file in your browser:`);
  console.log(`  ${outputPath}`);

  await db.close();
}

main().catch(console.error);
