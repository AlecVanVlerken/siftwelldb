/**
 * Deterministic seed data generator — produces ~200 employees with
 * realistic distributions across departments, cities, genders,
 * seniority levels, and salary ranges.
 */

const FIRST_NAMES_M = [
  'Adam','Arno','Bart','Ben','Bram','Chris','Daan','David','Dieter','Emile',
  'Felix','Florian','Gilles','Hans','Hugo','Jan','Jasper','Jonas','Joris','Kevin',
  'Lars','Luc','Maarten','Mathias','Nico','Olivier','Pieter','Quinten','Raf','Robbe',
  'Sam','Simon','Stef','Thomas','Tim','Tom','Victor','Wim','Wouter','Yves',
];

const FIRST_NAMES_F = [
  'Alice','An','Anouk','Britt','Charlotte','Clara','Diana','Elena','Emma','Eva',
  'Femke','Grace','Hanne','Ines','Iris','Jana','Julie','Karen','Laura','Lena',
  'Lisa','Lotte','Marie','Mia','Nadia','Noor','Olivia','Rosa','Sarah','Sofie',
  'Silke','Tina','Valerie','Yasmine','Zoe','Amber','Bo','Celine','Elke','Fien',
];

const LAST_NAMES = [
  'Janssen','Peeters','Maes','Willems','Claes','Dubois','Wouters','De Smedt',
  'Mertens','Hermans','Jacobs','Goossens','Pauwels','Van Damme','Pieters',
  'Leclercq','Adams','Vermeer','Aerts','Bogaert','De Groot','Vandenberghe',
  'Coppens','De Backer','Michiels','Stevens','Martens','Lambrechts','Hendrickx',
  'Van den Berg','Desmet','Raes','Leemans','Verhoeven','De Cock','Baert',
  'Smeets','Verschueren','Geerts','Nijs',
];

const DEPARTMENTS = ['Engineering','Marketing','Sales','HR','Finance','Operations','Support','Legal'];
const CITIES = ['Leuven','Gent','Antwerpen','Brussel','Brugge','Mechelen','Hasselt','Namur'];
const SENIORITY = ['Junior','Mid','Senior','Lead','Principal'];

type Employee = {
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

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function generateEmployees(count = 200): Employee[] {
  const rand = seededRandom(42);
  const pick = <T,>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
  const between = (lo: number, hi: number) => Math.round(lo + rand() * (hi - lo));

  const baseSalary: Record<string, number> = {
    Engineering: 70000, Finance: 68000, Legal: 66000, Marketing: 58000,
    Sales: 56000, Operations: 54000, HR: 55000, Support: 50000,
  };
  const seniorityMultiplier: Record<string, number> = {
    Junior: 0.75, Mid: 1.0, Senior: 1.25, Lead: 1.45, Principal: 1.7,
  };

  const employees: Employee[] = [];
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
    const salary = Math.round(base * mult * jitter / 500) * 500;

    const seniorityIdx = SENIORITY.indexOf(seniority);
    const minAge = 22 + seniorityIdx * 4;
    const maxAge = 30 + seniorityIdx * 8;
    const age = between(minAge, maxAge);
    const maxYears = Math.min(age - 21, 25);
    const yearsAtCompany = between(0, maxYears);

    employees.push({
      id: `emp${String(i + 1).padStart(3, '0')}`,
      name,
      gender,
      department,
      seniority,
      salary,
      age,
      city: pick(CITIES),
      yearsAtCompany,
    });
  }

  return employees;
}
