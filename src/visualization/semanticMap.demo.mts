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
// Uses `country` (noun form) to align with cities/landmarks/teams.
const FIGURES = [
  {
    id: 'Napoleon Bonaparte',
    country: 'France',
    profession: 'military leader',
    field: 'politics',
    era: '19th century',
  },
  { id: 'Albert Einstein', country: 'Germany', profession: 'physicist', field: 'science', era: '20th century' },
  { id: 'Wolfgang Amadeus Mozart', country: 'Austria', profession: 'composer', field: 'music', era: '18th century' },
  {
    id: 'Leonardo da Vinci',
    country: 'Italy',
    profession: 'artist inventor',
    field: 'art science',
    era: '15th century',
  },
  { id: 'Cleopatra', country: 'Egypt', profession: 'pharaoh', field: 'politics', era: '1st century BC' },
  { id: 'Mahatma Gandhi', country: 'India', profession: 'independence leader', field: 'politics', era: '20th century' },
  {
    id: 'Martin Luther King Jr',
    country: 'USA',
    profession: 'civil rights leader',
    field: 'politics',
    era: '20th century',
  },
  { id: 'Confucius', country: 'China', profession: 'philosopher', field: 'philosophy', era: '5th century BC' },
  { id: 'Socrates', country: 'Greece', profession: 'philosopher', field: 'philosophy', era: '5th century BC' },
  { id: 'Simon Bolivar', country: 'Venezuela', profession: 'liberator', field: 'politics', era: '19th century' },
];

// ── World landmarks ────────────────────────────────────────────────────────
// Shares `country`/`continent` with cities. `type` will also appear in AI chatbots.
const LANDMARKS = [
  { id: 'Eiffel Tower', country: 'France', continent: 'Europe', built: 1889, type: 'manmade' },
  { id: 'Colosseum', country: 'Italy', continent: 'Europe', built: 80, type: 'ancient' },
  { id: 'Sagrada Familia', country: 'Spain', continent: 'Europe', built: 1882, type: 'manmade' },
  { id: 'Great Wall', country: 'China', continent: 'Asia', built: 700, type: 'ancient' },
  { id: 'Taj Mahal', country: 'India', continent: 'Asia', built: 1643, type: 'ancient' },
  { id: 'Angkor Wat', country: 'Cambodia', continent: 'Asia', built: 1150, type: 'ancient' },
  { id: 'Pyramids of Giza', country: 'Egypt', continent: 'Africa', built: -2560, type: 'ancient' },
  { id: 'Statue of Liberty', country: 'USA', continent: 'America', built: 1886, type: 'manmade' },
  { id: 'Machu Picchu', country: 'Peru', continent: 'America', built: 1450, type: 'ancient' },
  { id: 'Sydney Opera House', country: 'Australia', continent: 'Oceania', built: 1973, type: 'manmade' },
];

// ── Champions League soccer teams ──────────────────────────────────────────
// `country`/`continent` align with cities/landmarks.
// `city` partially overlaps with city IDs (Madrid, Milan, Munich, Paris, London).
const SOCCER_TEAMS = [
  { id: 'Real Madrid', country: 'Spain', continent: 'Europe', city: 'Madrid', founded: 1902 },
  { id: 'FC Barcelona', country: 'Spain', continent: 'Europe', city: 'Barcelona', founded: 1899 },
  { id: 'Manchester City', country: 'UK', continent: 'Europe', city: 'Manchester', founded: 1880 },
  { id: 'Bayern Munich', country: 'Germany', continent: 'Europe', city: 'Munich', founded: 1900 },
  { id: 'Paris Saint-Germain', country: 'France', continent: 'Europe', city: 'Paris', founded: 1970 },
  { id: 'Liverpool', country: 'UK', continent: 'Europe', city: 'Liverpool', founded: 1892 },
  { id: 'Juventus', country: 'Italy', continent: 'Europe', city: 'Turin', founded: 1897 },
  { id: 'Ajax', country: 'Netherlands', continent: 'Europe', city: 'Amsterdam', founded: 1900 },
  { id: 'Borussia Dortmund', country: 'Germany', continent: 'Europe', city: 'Dortmund', founded: 1909 },
  { id: 'Inter Milan', country: 'Italy', continent: 'Europe', city: 'Milan', founded: 1908 },
];

// ── AI chatbots ────────────────────────────────────────────────────────────
// `country` aligns with all other categories.
// `type` aligns with landmarks (manmade/ancient vs proprietary/open-source).
const AI_CHATBOTS = [
  { id: 'ChatGPT', country: 'USA', company: 'OpenAI', launched: 2022, type: 'proprietary' },
  { id: 'Claude', country: 'USA', company: 'Anthropic', launched: 2023, type: 'proprietary' },
  { id: 'Gemini', country: 'USA', company: 'Google', launched: 2023, type: 'proprietary' },
  { id: 'Copilot', country: 'USA', company: 'Microsoft', launched: 2023, type: 'proprietary' },
  { id: 'Llama', country: 'USA', company: 'Meta', launched: 2023, type: 'open-source' },
  { id: 'Mistral', country: 'France', company: 'Mistral AI', launched: 2023, type: 'open-source' },
  { id: 'Grok', country: 'USA', company: 'xAI', launched: 2023, type: 'proprietary' },
  { id: 'Perplexity', country: 'USA', company: 'Perplexity AI', launched: 2022, type: 'proprietary' },
  { id: 'DeepSeek', country: 'China', company: 'DeepSeek', launched: 2024, type: 'open-source' },
  { id: 'Qwen', country: 'China', company: 'Alibaba', launched: 2023, type: 'open-source' },
];

// ── Dog breeds ─────────────────────────────────────────────────────────────
// `country` aligns with all other categories (country of origin).
const DOG_BREEDS = [
  { id: 'German Shepherd', country: 'Germany', size: 'large', group: 'herding' },
  { id: 'Golden Retriever', country: 'UK', size: 'large', group: 'sporting' },
  { id: 'French Bulldog', country: 'France', size: 'small', group: 'companion' },
  { id: 'Labrador Retriever', country: 'Canada', size: 'large', group: 'sporting' },
  { id: 'Siberian Husky', country: 'Russia', size: 'medium', group: 'working' },
  { id: 'Shiba Inu', country: 'Japan', size: 'small', group: 'hunting' },
  { id: 'Chow Chow', country: 'China', size: 'medium', group: 'working' },
  { id: 'Beagle', country: 'UK', size: 'small', group: 'hunting' },
  { id: 'Rottweiler', country: 'Germany', size: 'large', group: 'working' },
  { id: 'Poodle', country: 'France', size: 'medium', group: 'companion' },
];

async function main(): Promise<void> {
  console.log('Setting up database...');
  const dataFile = new MockFile(16 * 1024 * 1024);
  const logFile = new MockFile(65536);
  const db = await SimpleDbms.create(dataFile, logFile);

  for (const city of CITIES) await db.insertDocument('cities', JSON.stringify(city));
  for (const figure of FIGURES) await db.insertDocument('figures', JSON.stringify(figure));
  for (const landmark of LANDMARKS) await db.insertDocument('landmarks', JSON.stringify(landmark));
  for (const team of SOCCER_TEAMS) await db.insertDocument('soccer_teams', JSON.stringify(team));
  for (const bot of AI_CHATBOTS) await db.insertDocument('ai_chatbots', JSON.stringify(bot));
  for (const breed of DOG_BREEDS) await db.insertDocument('dog_breeds', JSON.stringify(breed));

  await db.commit();
  console.log(
    `Inserted ${CITIES.length} cities, ${FIGURES.length} figures, ${LANDMARKS.length} landmarks, ` +
      `${SOCCER_TEAMS.length} soccer teams, ${AI_CHATBOTS.length} AI chatbots, ${DOG_BREEDS.length} dog breeds.`,
  );

  console.log('Collecting documents...');
  const cityDocs = await collectDocuments(db, 'cities');
  const figureDocs = await collectDocuments(db, 'figures');
  const landmarkDocs = await collectDocuments(db, 'landmarks');
  const teamDocs = await collectDocuments(db, 'soccer_teams');
  const botDocs = await collectDocuments(db, 'ai_chatbots');
  const breedDocs = await collectDocuments(db, 'dog_breeds');

  const allDocs: RawDocument[] = [...cityDocs, ...figureDocs, ...landmarkDocs, ...teamDocs, ...botDocs, ...breedDocs];

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
    };
  });

  const outputPath = join(process.cwd(), 'map.html');
  renderMap(mapPoints, outputPath);

  console.log(`\nTotal: ${allDocs.length} documents across 6 collections.`);
  console.log(`Done! Open this file in your browser:`);
  console.log(`  ${outputPath}`);

  await db.close();
}

main().catch(console.error);
