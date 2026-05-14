/**
 * Deterministic demo data used by the main webclient.
 */

const FIRST_NAMES_M = [
  'Adam',
  'Arno',
  'Bart',
  'Ben',
  'Bram',
  'Chris',
  'Daan',
  'David',
  'Dieter',
  'Emile',
  'Felix',
  'Florian',
  'Gilles',
  'Hans',
  'Hugo',
  'Jan',
  'Jasper',
  'Jonas',
  'Joris',
  'Kevin',
  'Lars',
  'Luc',
  'Maarten',
  'Mathias',
  'Nico',
  'Olivier',
  'Pieter',
  'Quinten',
  'Raf',
  'Robbe',
  'Sam',
  'Simon',
  'Stef',
  'Thomas',
  'Tim',
  'Tom',
  'Victor',
  'Wim',
  'Wouter',
  'Yves',
];

const FIRST_NAMES_F = [
  'Alice',
  'An',
  'Anouk',
  'Britt',
  'Charlotte',
  'Clara',
  'Diana',
  'Elena',
  'Emma',
  'Eva',
  'Femke',
  'Grace',
  'Hanne',
  'Ines',
  'Iris',
  'Jana',
  'Julie',
  'Karen',
  'Laura',
  'Lena',
  'Lisa',
  'Lotte',
  'Marie',
  'Mia',
  'Nadia',
  'Noor',
  'Olivia',
  'Rosa',
  'Sarah',
  'Sofie',
  'Silke',
  'Tina',
  'Valerie',
  'Yasmine',
  'Zoe',
  'Amber',
  'Bo',
  'Celine',
  'Elke',
  'Fien',
];

const LAST_NAMES = [
  'Janssen',
  'Peeters',
  'Maes',
  'Willems',
  'Claes',
  'Dubois',
  'Wouters',
  'De Smedt',
  'Mertens',
  'Hermans',
  'Jacobs',
  'Goossens',
  'Pauwels',
  'Van Damme',
  'Pieters',
  'Leclercq',
  'Adams',
  'Vermeer',
  'Aerts',
  'Bogaert',
  'De Groot',
  'Vandenberghe',
  'Coppens',
  'De Backer',
  'Michiels',
  'Stevens',
  'Martens',
  'Lambrechts',
  'Hendrickx',
  'Van den Berg',
  'Desmet',
  'Raes',
  'Leemans',
  'Verhoeven',
  'De Cock',
  'Baert',
  'Smeets',
  'Verschueren',
  'Geerts',
  'Nijs',
];

const DEPARTMENTS = ['Engineering', 'Marketing', 'Sales', 'HR', 'Finance', 'Operations', 'Support', 'Legal'];
const CITIES = ['Leuven', 'Gent', 'Antwerpen', 'Brussel', 'Brugge', 'Mechelen', 'Hasselt', 'Namur'];
const SENIORITY = ['Junior', 'Mid', 'Senior', 'Lead', 'Principal'];

export type DemoEmployee = {
  id: string;
  name: string;
  gender: string;
  department: string;
  seniority: string;
  salary: number;
  age: number;
  city: string;
  yearsAtCompany: number;
};

export type SemanticKnowledgeDemoDocument = {
  id: string;
  category: string;
  title: string;
  body: string;
};

export const SEMANTIC_KNOWLEDGE_DEMO_DOCUMENTS: SemanticKnowledgeDemoDocument[] = [
  {
    id: 'ml-01',
    category: 'Machine Learning',
    title: 'Backpropagation',
    body: 'Backpropagation computes gradients layer-by-layer using the chain rule to train deep neural networks.',
  },
  {
    id: 'ml-02',
    category: 'Machine Learning',
    title: 'Gradient Descent',
    body: 'Gradient descent minimises the loss function by iteratively moving parameters in the direction of steepest descent.',
  },
  {
    id: 'ml-03',
    category: 'Machine Learning',
    title: 'Overfitting',
    body: 'Overfitting occurs when a model memorises training examples instead of learning generalisable patterns.',
  },
  {
    id: 'ml-04',
    category: 'Machine Learning',
    title: 'Convolutional Networks',
    body: 'CNNs apply learnable filters that slide over images to extract hierarchical visual features for classification.',
  },
  {
    id: 'ml-05',
    category: 'Machine Learning',
    title: 'Transformer Architecture',
    body: 'Transformers rely entirely on self-attention to model long-range dependencies, replacing recurrent networks.',
  },
  {
    id: 'ml-06',
    category: 'Machine Learning',
    title: 'Reinforcement Learning',
    body: 'RL agents learn optimal behaviour by maximising cumulative reward through trial and error in an environment.',
  },
  {
    id: 'ml-07',
    category: 'Machine Learning',
    title: 'Random Forests',
    body: 'Random forests combine many decision trees trained on random data subsets, reducing overfitting through ensemble averaging.',
  },
  {
    id: 'ml-08',
    category: 'Machine Learning',
    title: 'Attention Mechanism',
    body: 'Attention allows models to dynamically weight different parts of the input sequence when producing each output token.',
  },
  {
    id: 'fr-01',
    category: 'French History',
    title: 'French Revolution',
    body: 'The French Revolution began in 1789 with the storming of the Bastille, overthrowing the monarchy.',
  },
  {
    id: 'fr-02',
    category: 'French History',
    title: 'Eiffel Tower',
    body: "Built in 1889 for the Paris World's Fair, the Eiffel Tower stands 330 metres tall on the Champ de Mars.",
  },
  {
    id: 'fr-03',
    category: 'French History',
    title: 'Battle of Waterloo',
    body: "The Battle of Waterloo in 1815 ended Napoleon Bonaparte's rule and reshaped the map of Europe.",
  },
  {
    id: 'fr-04',
    category: 'French History',
    title: 'The Louvre',
    body: "The Louvre in Paris is the world's largest art museum, home to the Mona Lisa and Venus de Milo.",
  },
  {
    id: 'fr-05',
    category: 'French History',
    title: 'Napoleon Bonaparte',
    body: 'Napoleon rose from military general to Emperor of France, conquering much of Europe before his final exile after Waterloo.',
  },
  {
    id: 'fr-06',
    category: 'French History',
    title: 'Palace of Versailles',
    body: 'The Palace of Versailles was the royal residence of French kings from Louis XIV, symbolising absolute monarchy and Baroque architecture.',
  },
  {
    id: 'bio-01',
    category: 'Biology',
    title: 'DNA Double Helix',
    body: 'DNA is a double-helix polymer encoding genetic instructions in four nucleotide bases: A, T, C and G.',
  },
  {
    id: 'bio-02',
    category: 'Biology',
    title: 'CRISPR-Cas9',
    body: 'CRISPR-Cas9 enables precise in-vivo editing of DNA sequences, revolutionising genetic medicine and research.',
  },
  {
    id: 'bio-03',
    category: 'Biology',
    title: 'Photosynthesis',
    body: 'Plants convert sunlight, water and CO2 into glucose and oxygen through light-dependent reactions and the Calvin cycle.',
  },
  {
    id: 'bio-04',
    category: 'Biology',
    title: 'Natural Selection',
    body: 'Natural selection favours organisms with traits that improve survival and reproduction, driving evolutionary change across generations.',
  },
  {
    id: 'bio-05',
    category: 'Biology',
    title: 'Mitosis',
    body: 'Mitosis is the cell division process where one cell splits into two genetically identical daughter cells, enabling growth and tissue repair.',
  },
  {
    id: 'db-01',
    category: 'Databases',
    title: 'B+ Tree Indexes',
    body: 'B+ trees store sorted keys in linked leaf nodes, providing O(log n) point lookups and efficient range scans.',
  },
  {
    id: 'db-02',
    category: 'Databases',
    title: 'Write-Ahead Logging',
    body: 'WAL writes every change to a log before touching data pages, guaranteeing atomicity and crash recovery.',
  },
  {
    id: 'db-03',
    category: 'Databases',
    title: 'HNSW Vector Index',
    body: 'HNSW builds a hierarchical navigable small world graph of embeddings, enabling approximate nearest-neighbour search in sub-linear time.',
  },
  {
    id: 'db-04',
    category: 'Databases',
    title: 'ACID Transactions',
    body: 'ACID guarantees atomicity, consistency, isolation and durability, ensuring database transactions are reliably processed even after failures.',
  },
  {
    id: 'space-01',
    category: 'Space & Astronomy',
    title: 'Black Holes',
    body: 'Black holes are regions where gravity is so extreme that not even light can escape, forming when massive stars collapse at the end of their life.',
  },
  {
    id: 'space-02',
    category: 'Space & Astronomy',
    title: 'The Big Bang',
    body: 'The Big Bang describes the rapid expansion of the universe from an ultra-dense singularity approximately 13.8 billion years ago.',
  },
  {
    id: 'space-03',
    category: 'Space & Astronomy',
    title: 'Mars Exploration',
    body: 'NASA rovers Curiosity and Perseverance study Martian geology and atmosphere, searching for signs of ancient microbial life.',
  },
  {
    id: 'space-04',
    category: 'Space & Astronomy',
    title: 'Exoplanets',
    body: 'Exoplanets orbit stars outside our solar system; the James Webb Space Telescope analyses their atmospheres for potential biosignatures.',
  },
  {
    id: 'sport-01',
    category: 'Sports',
    title: 'Formula 1',
    body: 'Formula 1 cars reach over 350 km/h using hybrid power units, advanced aerodynamic downforce and ultra-grippy slick tyres.',
  },
  {
    id: 'sport-02',
    category: 'Sports',
    title: 'Football',
    body: 'Football is the most popular sport in the world, played by two teams of eleven players each aiming to kick the ball into the opposing goal.',
  },
  {
    id: 'sport-03',
    category: 'Sports',
    title: 'Olympic Games',
    body: 'The Olympic Games unite athletes from over 200 nations every four years to compete across dozens of summer and winter sport disciplines.',
  },
  {
    id: 'sport-04',
    category: 'Sports',
    title: 'Tennis',
    body: 'Tennis players score points by hitting a ball over a net so the opponent cannot return it, competing in Grand Slam tournaments worldwide.',
  },
];

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function generateDemoEmployees(count = 200): DemoEmployee[] {
  const rand = seededRandom(42);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const between = (lo: number, hi: number): number => Math.round(lo + rand() * (hi - lo));

  const baseSalary: Record<string, number> = {
    Engineering: 70000,
    Finance: 68000,
    Legal: 66000,
    Marketing: 58000,
    Sales: 56000,
    Operations: 54000,
    HR: 55000,
    Support: 50000,
  };
  const seniorityMultiplier: Record<string, number> = {
    Junior: 0.75,
    Mid: 1.0,
    Senior: 1.25,
    Lead: 1.45,
    Principal: 1.7,
  };

  const employees: DemoEmployee[] = [];
  const usedNames = new Set<string>();

  for (let i = 0; i < count; i++) {
    const gender = rand() < 0.48 ? 'M' : 'F';
    const firstName = gender === 'M' ? pick(FIRST_NAMES_M) : pick(FIRST_NAMES_F);
    const lastName = pick(LAST_NAMES);
    let name = `${firstName} ${lastName}`;
    if (usedNames.has(name)) name = `${firstName} ${pick(LAST_NAMES)}`;
    usedNames.add(name);

    const department = pick(DEPARTMENTS);
    const seniority = pick(SENIORITY);
    const base = baseSalary[department] ?? 55000;
    const mult = seniorityMultiplier[seniority] ?? 1.0;
    const jitter = 1 + (rand() - 0.5) * 0.2;
    const salary = Math.round((base * mult * jitter) / 500) * 500;

    const seniorityIdx = SENIORITY.indexOf(seniority);
    const minAge = 22 + seniorityIdx * 4;
    const maxAge = 30 + seniorityIdx * 8;
    const age = between(minAge, maxAge);
    const maxYears = Math.min(age - 21, 25);

    employees.push({
      id: `emp${String(i + 1).padStart(3, '0')}`,
      name,
      gender,
      department,
      seniority,
      salary,
      age,
      city: pick(CITIES),
      yearsAtCompany: between(0, maxYears),
    });
  }

  return employees;
}

export function generateSemanticKnowledgeDemoDocuments(): SemanticKnowledgeDemoDocument[] {
  return SEMANTIC_KNOWLEDGE_DEMO_DOCUMENTS.map((document) => ({ ...document }));
}
