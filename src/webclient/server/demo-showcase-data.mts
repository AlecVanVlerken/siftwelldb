import type { FieldValue } from '../../database/document.mjs';
import type { FieldCompressionDefaults } from '../../database/compression.mjs';
import { generateDemoEmployees, generateSemanticKnowledgeDemoDocuments } from './demo-data.mjs';

export type ShowcaseDocument = Record<string, FieldValue>;

export type ShowcaseCollection = {
  name: string;
  documents: ShowcaseDocument[];
  unindexedFields: string[];
  compressionDefaults?: FieldCompressionDefaults;
};

export const SHOWCASE_DEFAULT_COUNTS = {
  employees: 200,
  products: 160,
  orders: 400,
  articles: 240,
  travel_guides: 64,
  support_tickets: 120,
};

export type ShowcaseCounts = typeof SHOWCASE_DEFAULT_COUNTS;

function checkCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > 10000) {
    throw new RangeError('Demo collection counts must be integers between 0 and 10000.');
  }
}

function documentId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(4, '0')}`;
}

const PRODUCT_FAMILIES = [
  [
    'Outdoors',
    'Trail backpack',
    'Northfield',
    49.95,
    'A waterproof day pack with padded straps, a rain cover and separate pockets for a map and water bottle.',
  ],
  [
    'Kitchen',
    'Coffee grinder',
    'Millstone',
    69.9,
    'An adjustable burr grinder for fresh espresso, filter coffee and a quiet morning routine at home.',
  ],
  [
    'Electronics',
    'Wireless headphones',
    'Waveform',
    89.5,
    'Noise cancelling over-ear headphones for music, video calls and focused work on busy trains.',
  ],
  [
    'Garden',
    'Herb growing kit',
    'Greenleaf',
    18.75,
    'Reusable pots, labelled seeds and a drainage tray for growing basil, mint and parsley on a sunny balcony.',
  ],
  [
    'Fitness',
    'Yoga mat',
    'Balance',
    29.95,
    'A cushioned exercise mat with a textured surface and carry strap for stretching, yoga and home workouts.',
  ],
  [
    'Photography',
    'Camera tripod',
    'Clearview',
    74.5,
    'A folding aluminium tripod with an adjustable head for landscapes, wildlife photography and long exposures.',
  ],
  [
    'Cycling',
    'Bicycle repair kit',
    'Veloworks',
    24.9,
    'A compact tyre pump, patches and folding tools for fixing punctures during commutes and countryside rides.',
  ],
  [
    'Books',
    'Astronomy field guide',
    'Open Page',
    22.5,
    'An illustrated paperback introducing planets, seasonal constellations and practical observation of the night sky.',
  ],
] as const;

export function generateDemoProducts(count = SHOWCASE_DEFAULT_COUNTS.products): ShowcaseDocument[] {
  checkCount(count);
  return Array.from({ length: count }, (_, index) => {
    const [category, name, brand, basePrice, description] = PRODUCT_FAMILIES[index % PRODUCT_FAMILIES.length];
    const edition = Math.floor(index / PRODUCT_FAMILIES.length);
    const tier = edition % 3;
    const stock = (index * 17 + 11) % 151;
    return {
      id: documentId('product', index),
      name: `${name} ${['Essential', 'Plus', 'Pro'][tier]} ${Math.floor(edition / 3) + 1}`,
      category,
      brand,
      price: Math.round(basePrice * [1, 1.35, 1.8][tier] * (1 + Math.floor(edition / 3) * 0.04) * 100) / 100,
      stock,
      rating: Math.round((3.5 + ((index * 7) % 16) / 10) * 10) / 10,
      available: stock > 0,
      description: `${description} The ${['Essential', 'Plus', 'Pro'][tier]} edition includes ${['the standard accessory set', 'an extended warranty and reusable storage case', 'reinforced fittings and a full accessory set'][tier]}.`,
      supplierNote:
        index % 2 ? 'Local warehouse; dispatch on working days.' : 'Regional supplier; restock reviewed every Monday.',
    };
  });
}

export function generateDemoOrders(
  products: ShowcaseDocument[],
  count = SHOWCASE_DEFAULT_COUNTS.orders,
): ShowcaseDocument[] {
  checkCount(count);
  if (count > 0 && products.length === 0) throw new RangeError('Demo orders require at least one product.');
  return Array.from({ length: count }, (_, index) => {
    const product = products[(index * 37 + Math.floor(index / products.length)) % products.length];
    const quantity = 1 + ((index * 3 + Math.floor(index / 13)) % 5);
    if (typeof product['id'] !== 'string' || typeof product['price'] !== 'number') {
      throw new TypeError('Demo products require a string ID and numeric price.');
    }
    return {
      id: documentId('order', index),
      customerName: `${['Alice', 'Bram', 'Clara', 'Daan', 'Emma', 'Felix', 'Grace', 'Hugo'][index % 8]} ${['Janssen', 'Dubois', 'Vermeer', 'Peeters', 'Willems'][Math.floor(index / 8) % 5]}`,
      customerId: `customer-${String((index % 80) + 1).padStart(3, '0')}`,
      productId: product['id'],
      quantity,
      unitPrice: product['price'],
      total: (Math.round(product['price'] * 100) * quantity) / 100,
      status: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'][(index + Math.floor(index / 7)) % 5],
      orderDate: `2026-${String(1 + (Math.floor(index / 28) % 12)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`,
      country: ['Belgium', 'Netherlands', 'France', 'Germany', 'Portugal', 'Italy'][index % 6],
      city: ['Ghent', 'Utrecht', 'Lille', 'Cologne', 'Lisbon', 'Bologna'][index % 6],
      express: index % 4 === 0,
    };
  });
}

type Destination = {
  name: string;
  country: string;
  category: string;
  summary: string;
  morning: string;
  afternoon: string;
  practical: string;
};

const DESTINATIONS: Destination[] = [
  {
    name: 'Ardennes',
    country: 'Belgium',
    category: 'Nature',
    summary:
      'Forest hiking, river kayaking and quiet villages in wooded valleys offer a gentle outdoor escape in the Belgian Ardennes.',
    morning:
      'Begin with a marked walk above the Ourthe valley. Tree roots and wet leaves can make the path slippery, so choose a route matching the group rather than a distance copied from a map. Stop where the trail opens onto the river and watch for birds along the banks.',
    afternoon:
      'Choose a riverside village for lunch, then visit a small local museum or join a permitted kayaking trip when water conditions allow. Keep a shorter woodland loop available if rain changes the plan. Quiet observation often reveals more wildlife than rushing between viewpoints.',
    practical:
      'Some rural bus routes are infrequent. Check return transport before leaving, carry drinking water and keep to marked paths. Paddling conditions depend on water levels and local restrictions; use an authorised operator and leave nesting sites undisturbed.',
  },
  {
    name: 'Ghent',
    country: 'Belgium',
    category: 'Culture',
    summary:
      'Ghent combines historic canals, medieval architecture, art museums and vegetarian food in a city suited to walking and cycling.',
    morning:
      'Follow the canal-side streets around the historic centre and compare the narrow older plots with later public squares. Pause at a bakery before entering a museum. Leaving space between visits makes it easier to notice architectural details and everyday use of the city.',
    afternoon:
      'Spend time in a neighbourhood beyond the busiest waterfront, then visit an exhibition or a local market. A short boat trip offers a different view of bridges and old trading buildings. Choose a restaurant with seasonal ingredients rather than trying to fit every attraction into one day.',
    practical:
      'Trams connect the station to the centre. Respect cycle lanes, allow extra time on cobbled streets and check museum opening days. Reserve popular activities ahead when necessary and use refill points instead of buying a new plastic bottle at each stop.',
  },
  {
    name: 'Lisbon',
    country: 'Portugal',
    category: 'Coast',
    summary:
      'Lisbon offers hilltop viewpoints, tile-covered streets, museums and nearby ocean beaches connected by urban and regional transport.',
    morning:
      'Start early on a hillside walk while the streets are cooler. Look at the patterns of ceramic tiles and the relationship between steep steps and tram routes. A viewpoint above the river is a useful place to orient yourself before descending into the older neighbourhoods.',
    afternoon:
      'Choose a museum or a shaded garden, then take a planned coastal train excursion if time allows. Atlantic beaches have changing surf conditions; a beach day should follow local safety information. Return for a simple meal and leave time for a relaxed waterfront walk.',
    practical:
      'The hills require comfortable footwear, and polished paving can be slippery. Use public transport for longer climbs, protect yourself from the sun and verify the last train home. Ocean water is often cooler than visitors expect, even during sunny weather.',
  },
  {
    name: 'Tromso',
    country: 'Norway',
    category: 'Winter',
    summary:
      'Tromso combines Arctic city life with snowy landscapes, northern-light watching and carefully planned outdoor trips.',
    morning:
      'Begin with the harbour and a museum explaining northern environments. In winter, limited daylight changes the rhythm of a visit. A short coastal walk can reveal snowy mountains without requiring a long expedition, while cafes provide warm pauses between outdoor activities.',
    afternoon:
      'Book a guided activity appropriate to the season and conditions. Northern lights require clear skies and sufficient darkness, so an evening outing is an opportunity rather than a guarantee. In summer, long daylight supports a different itinerary centred on walking and coastal scenery.',
    practical:
      'Wear layered clothing and footwear with suitable grip. Weather changes quickly, and remote roads can be affected by snow. Choose experienced guides for exposed outings, avoid disturbing wildlife and make an indoor alternative part of the plan.',
  },
  {
    name: 'Kyoto',
    country: 'Japan',
    category: 'Culture',
    summary:
      'Temple gardens, traditional streets, tea houses and seasonal landscapes make Kyoto a rewarding place for deliberate cultural exploration.',
    morning:
      'Visit a temple garden early and spend time observing the relationship between paths, stones, water and planted areas. Read the site guidance before photographing or entering buildings. Choose one area to explore thoroughly rather than travelling across the whole city for a checklist of landmarks.',
    afternoon:
      'Walk through a shopping street and try a meal based on local seasonal ingredients. A craft workshop or small exhibition gives context to the objects sold nearby. Leave room for a quiet riverside walk and notice how visitors and residents share the same public spaces.',
    practical:
      'Public transport serves many areas, but walking distances within sites can be substantial. Follow photography rules and respect residential lanes. Seasonal attractions can be crowded; check access conditions and distribute visits across less busy times.',
  },
  {
    name: 'Dolomites',
    country: 'Italy',
    category: 'Mountains',
    summary:
      'Limestone peaks, alpine meadows and mountain villages make the Dolomites a destination for hiking, cycling and landscape photography.',
    morning:
      'Choose a marked valley or mountain route matching fitness, experience and weather. Open meadows can offer excellent views without committing to exposed ridges. Study the map before starting and note the point where turning back remains straightforward.',
    afternoon:
      'Return through a village for a meal and an exhibition about local landscapes or crafts. A lower-altitude walk is a good alternative when clouds hide the peaks. Photographers can revisit one accessible viewpoint as the light changes instead of driving constantly between distant locations.',
    practical:
      'Mountain weather may change rapidly. Carry layers, water and a map, and check trail access and transport schedules. Technical climbing routes require the relevant training and equipment. Stay on marked trails to protect fragile plants and reduce erosion.',
  },
  {
    name: 'Reykjavik',
    country: 'Iceland',
    category: 'Geography',
    summary:
      'Reykjavik is a base for exploring museums, volcanic landscapes, hot springs and coastal scenery with responsible local guidance.',
    morning:
      'Explore the waterfront and a museum that explains the island geological setting. Looking at rock samples before a field trip makes lava textures and layered landscapes easier to interpret. A city walk also offers cafes and architecture when weather makes longer travel impractical.',
    afternoon:
      'Take a suitable guided excursion or visit a public geothermal pool. Waterfalls and coastlines should be viewed from designated paths. Select a manageable route and spend time at each stop rather than measuring the quality of the day by distance travelled.',
    practical:
      'Wind, road conditions and local closures affect travel. Follow official access guidance, keep away from unstable ground and never cross a barrier for a photograph. Bring waterproof layers and respect bathing rules at pools.',
  },
  {
    name: 'Amsterdam',
    country: 'Netherlands',
    category: 'City',
    summary:
      'Canal routes, art museums, bicycle paths and neighbourhood markets offer many ways to understand Amsterdam beyond a hurried centre visit.',
    morning:
      'Walk along quieter canals and compare bridge designs, house fronts and waterside trees. A museum visit can connect the streets to the history of trade and visual culture. Choose a timed entry when required and leave space to linger over a few works.',
    afternoon:
      'Take a tram to a neighbourhood market or a park, then explore on foot. A canal boat tour offers context for the water system. If cycling, familiarise yourself with local road rules and choose a route suited to your experience.',
    practical:
      'Cycle lanes are working transport routes, so do not stand in them to take photographs. Check museum booking requirements and tram connections. Keep noise low in residential streets and favour established paths along sensitive waterside areas.',
  },
];

const TRAVEL_PERSPECTIVES = [
  [
    'a weekend escape',
    'Keep the itinerary compact and reserve one flexible block. A weekend works best when transport is simple and the first evening does not depend on a tight connection.',
  ],
  [
    'a family adventure',
    'Build in snack stops and choose activities with a shorter alternative. Let children help select a museum object or a trail landmark to look for during the day.',
  ],
  [
    'a budget itinerary',
    'Combine a paid visit with public spaces and a simple picnic. Compare transport passes against the trips actually planned rather than assuming a pass always saves money.',
  ],
  [
    'a photography trip',
    'Return to one accessible location in different light. Ask permission for close portraits, keep equipment clear of paths and prioritise safety over an unusual angle.',
  ],
  [
    'a slow travel plan',
    'Stay in one neighbourhood or valley for longer and use local transport. Repeated visits to a cafe, market or walking route reveal details that a hurried tour misses.',
  ],
  [
    'an outdoor holiday',
    'Plan around weather and daylight rather than a rigid list. Share the route with someone, carry appropriate equipment and keep an easy alternative ready.',
  ],
  [
    'a museum and food itinerary',
    'Connect an exhibition to a nearby neighbourhood meal. Read labels carefully, ask about ingredients and leave time to discuss what changed your understanding of the place.',
  ],
  [
    'a quieter seasonal visit',
    'Expect shorter opening hours and different transport schedules outside busy periods. Fewer visitors can make observation easier, but services and weather still need checking.',
  ],
] as const;

export function generateDemoTravelGuides(count = SHOWCASE_DEFAULT_COUNTS.travel_guides): ShowcaseDocument[] {
  checkCount(count);
  return Array.from({ length: count }, (_, index) => {
    const destination = DESTINATIONS[index % DESTINATIONS.length];
    const [perspective, advice] =
      TRAVEL_PERSPECTIVES[Math.floor(index / DESTINATIONS.length) % TRAVEL_PERSPECTIVES.length];
    return {
      id: documentId('guide', index),
      title: `${destination.name}: ${perspective}`,
      summary: `${destination.summary} This itinerary focuses on ${perspective}.`,
      destination: destination.name,
      country: destination.country,
      category: destination.category,
      days: 2 + (Math.floor(index / DESTINATIONS.length) % 6),
      budgetEur: 180 + (index % 8) * 55 + Math.floor(index / 8) * 20,
      body: `${destination.summary}\n\nMorning: finding your bearings\n${destination.morning}\n\nAfternoon: a closer look\n${destination.afternoon}\n\nPlanning ${perspective}\n${advice}\n\nBefore leaving\n${destination.practical}\n\nThis is a fictional planning guide for the demo, not a live schedule. Confirm access, weather, prices and transport locally before making bookings. A good visit balances curiosity with the needs of residents and the environment.`,
    };
  });
}

const TICKET_ISSUES = [
  [
    'Delivery',
    'Parcel tracking stopped',
    'The parcel left the sorting centre three days ago, but no new scan has appeared. The delivery address is correct and nobody has received a card.',
    'Ask the carrier to locate the last scan and agree a replacement deadline if the parcel cannot be found.',
  ],
  [
    'Returns',
    'Damaged ceramic mug',
    'The outer box looked intact, but the handle broke during transport. I kept the packaging and can provide photographs of the damage.',
    'Send a prepaid return label or arrange a replacement after reviewing the photographs.',
  ],
  [
    'Account',
    'Password reset email missing',
    'I requested a password reset twice and checked the spam folder. The address still receives order confirmations, but the reset link never arrives.',
    'Verify the account address and mail delivery logs, then send a fresh single-use reset link.',
  ],
  [
    'Payment',
    'Duplicate card charge',
    'My bank statement shows two completed payments for one order. The confirmation lists only one purchase and I did not press the payment button again.',
    'Compare payment references and refund the duplicate after verifying that both charges settled.',
  ],
  [
    'Technical',
    'Bluetooth pairing fails',
    'The headphones enter pairing mode, but my laptop says the connection failed. Restarting both devices and removing the previous pairing did not help.',
    'Check firmware and the audio profile, then test pairing with another device to isolate the fault.',
  ],
  [
    'Product',
    'Waterproof bag advice',
    'I am preparing for a wet weekend hiking trip. I need space for spare clothes and want to know whether the pack includes a separate rain cover.',
    'Explain the waterproofing limits, dimensions and included rain cover without promising immersion protection.',
  ],
  [
    'Delivery',
    'Wrong apartment number',
    'The dispatch notice contains an old apartment number. The street and postcode are right, but the courier may not find the correct door.',
    'Request a carrier address correction and confirm whether redirection is still possible.',
  ],
  [
    'Returns',
    'Size exchange request',
    'The exercise mat is wider than the shelf where I planned to store it. It has not been used and I would prefer the smaller model.',
    'Confirm the return window and exchange stock, then explain the price difference before issuing a label.',
  ],
  [
    'Technical',
    'Coffee grinder stalls',
    'The motor starts and then stops while grinding beans. I cleaned the removable hopper following the guide, but the problem returns on the next use.',
    'Ask for a short fault description, check approved cleaning steps and arrange inspection if the fault persists.',
  ],
  [
    'Payment',
    'Invoice needs company details',
    'The receipt uses my personal address, but the purchase was for our office. I need the company name and billing details included on the invoice.',
    'Validate the requested billing information and issue a corrected invoice preserving the original order reference.',
  ],
  [
    'Account',
    'Notification preferences ignored',
    'I turned off promotional messages last week, yet another newsletter arrived today. Delivery updates are still useful and should remain enabled.',
    'Check preference propagation, remove the promotional subscription and keep transactional notices enabled.',
  ],
  [
    'Product',
    'Replacement tripod plate',
    'The quick-release plate was lost during a photography trip. The tripod is otherwise in good condition and I would like a compatible spare.',
    'Identify the model from its label and offer the matching replacement plate with installation guidance.',
  ],
  [
    'Delivery',
    'Collection point closed',
    'The selected pickup shop is temporarily closed. Tracking says the package is ready there, but the posted opening hours are no longer correct.',
    'Contact the carrier and arrange transfer to an operating collection point after confirming customer consent.',
  ],
  [
    'Technical',
    'Repair pump valve confusion',
    'The bicycle pump fits one bicycle but not the valve on my commuting bike. I cannot tell whether an adapter is included in the kit.',
    'Explain the supported valve types and the adapter location with a clear diagram reference.',
  ],
  [
    'Returns',
    'Missing accessory pouch',
    'The backpack arrived without the advertised accessory pouch. The main bag is fine and I would prefer the missing part instead of returning everything.',
    'Verify the edition contents and dispatch the missing accessory if it was included in the purchase.',
  ],
  [
    'Product',
    'Seeds not sprouting',
    'The herb kit has been on a bright windowsill for two weeks. The soil stays moist, but only a few seeds have germinated.',
    'Review sowing depth, room temperature and watering, then replace the seed batch if appropriate.',
  ],
  [
    'Account',
    'Export personal information',
    'I would like a copy of my saved addresses and order history before closing the account. Please explain how identity verification works.',
    'Follow the established identity verification procedure and provide the account export through a secure channel.',
  ],
  [
    'Payment',
    'Refund not visible yet',
    'The return was approved and an email says the refund was processed. My bank balance has not changed, and I need the payment reference.',
    'Confirm the refund date and reference and explain the payment provider processing window.',
  ],
  [
    'Technical',
    'Headphone microphone too quiet',
    'Music playback is normal, but colleagues can barely hear me in calls. The meeting application uses the headset microphone and its volume is already high.',
    'Check application permissions and input profile, compare another application and inspect the microphone opening.',
  ],
  [
    'Product',
    'Field guide accessibility',
    'I am buying the astronomy guide for someone who prefers large diagrams. Could you describe the text size and whether constellation charts use high contrast?',
    'Provide measured format information and sample-page guidance without guessing about personal accessibility needs.',
  ],
] as const;

export function generateDemoSupportTickets(count = SHOWCASE_DEFAULT_COUNTS.support_tickets): ShowcaseDocument[] {
  checkCount(count);
  return Array.from({ length: count }, (_, index) => {
    const [category, title, issue, resolution] = TICKET_ISSUES[index % TICKET_ISSUES.length];
    const caseNumber = Math.floor(index / TICKET_ISSUES.length);
    const status = ['open', 'in_progress', 'resolved'][Math.floor(index / 3) % 3];
    const circumstances = [
      'I can be reached by email in the afternoon and would appreciate a written summary of the next step.',
      'This was a gift order, so please contact me before changing the delivery or sending a replacement.',
      'I tried the steps in the help page and noted the result of each attempt. I can share those notes if useful.',
      'I will be away later this week. Please let me know whether the proposed solution requires someone to be at home.',
      'A colleague placed the order on my behalf. We can provide the confirmation number after the account details are verified.',
      'There is no urgent deadline, but I would like an estimate and a clear explanation of any cost before proceeding.',
    ][caseNumber % 6];
    return {
      id: documentId('ticket', index),
      title,
      description: `${issue} ${circumstances}`,
      category,
      priority: ['normal', 'high', 'low'][(index + caseNumber) % 3],
      status,
      customer: `Customer ${String((index % 80) + 1).padStart(3, '0')}`,
      createdAt: `2026-${String(1 + (Math.floor(index / 28) % 6)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`,
      ...(status === 'resolved' ? { resolution, satisfaction: 3 + (index % 3) } : {}),
    };
  });
}

type ArticleTopic = {
  title: string;
  category: string;
  summary: string;
  tags: string;
  question: string;
  example: string;
  sections: [string, string, string, string];
};

// Authored educational cores are combined with explicit perspectives below.
// This is a local, reproducible collection of variations, not scraped articles.
const ARTICLE_TOPICS: ArticleTopic[] = [
  {
    title: 'How Databases Organize Information',
    category: 'Databases',
    tags: 'storage, indexes, documents',
    summary:
      'Database pages, document records and indexes cooperate to make information durable and searchable without copying every value into every structure.',
    question: 'How does the chosen index change the work needed to answer a question?',
    example:
      'Compare finding one employee by ID with listing employees from the same department, then observe the difference between reading candidate records and sorting a result.',
    sections: [
      'A database file is usually divided into pages or blocks. Records occupy space within that layout, and larger records may need a chain of storage units. The logical document seen by an application is therefore different from its physical representation. A document can remain identical even when maintenance moves its bytes to a new location. References must be updated consistently whenever that movement occurs.',
      'An index stores a searchable representation of selected fields together with references to records. A B+ tree keeps keys ordered and directs a lookup through a shallow hierarchy. Its leaf pages contain the candidate references. Several documents may share a department or category, so a secondary index must preserve every matching reference rather than treating the shared value as a unique identity.',
      'Indexes trade extra storage and mutation work for faster retrieval. Changing an indexed field may require removing one entry and adding another, while changing an unindexed body avoids that particular work. A long article body is a poor candidate for an ordinary key because key size is limited and whole-body equality is rarely useful. Short titles, categories and stable identifiers are more practical choices.',
      'A query still needs a plan after candidate discovery. It may fetch records, evaluate additional predicates, calculate aggregates and sort the surviving rows. The presence of an index does not imply that every operation uses it or that the final result is already in the requested order. Measuring candidate counts and returned rows helps distinguish an effective lookup from a broad scan followed by filtering.',
    ],
  },
  {
    title: 'Why Write-Ahead Logs Matter',
    category: 'Databases',
    tags: 'durability, recovery, logging',
    summary:
      'Write-ahead logging records recovery information before database changes become durable, allowing reopening to resolve interrupted writes.',
    question: 'What evidence remains if an operation stops between two physical writes?',
    example:
      'Follow a document edit through its record, ID index and secondary index, and identify which persisted evidence a reopening procedure needs after interruption.',
    sections: [
      'A logical edit can touch several storage locations. Replacing a document may allocate new record blocks, change an ID entry and update multiple secondary indexes. An operating system can also complete only part of a requested write. Treating one successful write as proof that the whole logical operation completed confuses physical progress with application-level consistency. Recovery needs a clear record of the intended boundaries.',
      'A write-ahead log supplies that evidence before the corresponding data changes are considered durable. The exact format varies between engines, but ordering is central: recovery information must survive before the data it describes relies on it. Flushing and synchronisation are different from merely calling a write function. The design must account for buffers in both the process and the operating system.',
      'Reopening should inspect available recovery evidence and either restore a consistent state or refuse to continue when essential evidence is missing or corrupt. Silent guessing is dangerous because a plausible index can still point to the wrong record. Recovery tests therefore inject short writes, failed synchronisation and interruption at meaningful stages rather than only checking that an ordinary close and open succeeds.',
      'Logging is not a substitute for every transaction feature. An engine may protect committed storage while requiring a failed mutation session to be closed and reopened. Applications should understand the guarantees actually offered, especially when a request performs several logical writes. Clear errors, safe session gating and a documented recovery procedure are more useful than claiming atomicity beyond the implementation.',
    ],
  },
  {
    title: 'Searching by Meaning with Vector Indexes',
    category: 'Artificial Intelligence',
    tags: 'embeddings, semantic search, similarity',
    summary:
      'Embedding models map related text or images to nearby vectors, while approximate indexes find promising neighbours without replacing ordinary document filters.',
    question: 'What makes a similar result useful for the person asking the question?',
    example:
      'Search for equipment for a rainy hiking trip and compare waterproof backpacks with unrelated products that happen to share the word trip.',
    sections: [
      'An embedding is a sequence of numbers produced by a trained model. Its usefulness comes from the relationships learned during training: descriptions about similar concepts can receive nearby representations even when their wording differs. The numbers do not independently explain why a result is relevant. Interpretation still depends on the model, the input text and the similarity measure used by the search system.',
      'Text and image models can have different vector dimensions and different purposes. A text model compares written descriptions, while an image-language model can compare an image with a textual prompt in its shared space. Those paths should remain explicit. A photograph without a descriptive caption can participate in image retrieval without pretending that a text-document model understands the visual content stored as binary bytes.',
      'Approximate nearest-neighbour structures such as HNSW arrange vectors in a graph that supports efficient exploration. They aim to find good candidates with less work than exhaustive comparison, but the result is approximate. Search settings trade speed against recall. Deletion also needs careful handling: a graph may retain a deleted node for navigation while excluding its document from live search results.',
      'Good input matters as much as the index. Long documents may exceed a model token limit, so useful titles and concise summaries should appear before distant details. Search quality should be assessed with representative questions and inspected results rather than a single impressive example. Metadata filters, exact lookups and semantic similarity serve different needs and can complement one another in the same application.',
    ],
  },
  {
    title: 'How Networks Move Messages',
    category: 'Technology',
    tags: 'networks, packets, communication',
    summary:
      'Packet networks divide communication into smaller units, route them through shared infrastructure and recover from loss using agreed protocols.',
    question: 'Which part of a slow conversation is caused by delay, loss or the application itself?',
    example:
      'Trace a browser request from a laptop through a home router to a server, separating connection setup from the time spent preparing the response.',
    sections: [
      'A network message rarely travels as one indivisible object. Protocols divide information into packets or frames with addressing and control information. Different layers handle local links, routing and the conversation between endpoints. Keeping those responsibilities separate lets a web application operate over many physical technologies without needing to understand every radio channel or cable along the route.',
      'Routers forward packets according to destination information and available routes. Shared links have finite capacity, and busy queues introduce delay. A high advertised bandwidth therefore does not guarantee a quick response to every small request. The time needed for a signal to travel, queueing along the path and server processing can all matter even when the application sends very little data.',
      'Reliable transport adds ordering, acknowledgement and retransmission to an unreliable underlying path. Recovery from loss costs time, and congestion control avoids overwhelming shared capacity. Applications also need their own request boundaries and error handling. Receiving bytes at the transport layer does not prove that a server understood a command or completed a database operation successfully.',
      'Practical diagnosis starts with a question rather than a favourite tool. Is every destination slow, or only one service? Does the problem follow a device, a wireless location or a particular operation? Comparing small controlled requests helps isolate the layer involved. Record the conditions and repeat measurements before changing several settings at once, otherwise the apparent improvement may be unrelated.',
    ],
  },
  {
    title: 'Sensors Turn Environments into Data',
    category: 'Technology',
    tags: 'sensors, measurement, calibration',
    summary:
      'Sensors translate physical conditions into signals, but calibration, sampling and placement determine whether those signals answer the intended question.',
    question: 'Does the measured signal represent the condition we actually care about?',
    example:
      'Place temperature sensors in shade, beside a window and near a heater, then explain why the readings describe different local conditions.',
    sections: [
      'A sensor converts a physical quantity into a signal that another system can record. Temperature, light, motion and pressure are familiar examples. The conversion is never completely detached from the instrument: sensitivity, noise, response time and operating range affect the reading. A numerical display can look precise even when its position or calibration makes the observation unsuitable for a particular decision.',
      'Calibration compares the instrument against a known reference under defined conditions. It may reveal an offset, a scale error or a response that changes across the range. Recording the calibration procedure is essential because a correction derived at one temperature or humidity may not apply everywhere. Maintenance also matters: dust, ageing components and changed mounting can alter behaviour after an initially successful setup.',
      'Sampling determines which changes become visible. A sensor recorded once each hour may describe a daily trend while missing short events. Faster sampling increases data volume and does not automatically remove noise. The chosen interval should follow the question and the physical process. A slowly changing room temperature and a vibrating motor need very different observation strategies.',
      'Placement is part of measurement design. A reading near a heat source cannot simply be labelled as the temperature of an entire room. Multiple locations, a consistent installation method and contextual notes make interpretation more credible. Before building an alert, identify what a false alarm or a missed event would cost and test the system against real conditions rather than an idealised bench example.',
    ],
  },
  {
    title: 'Algorithms as Choices about Work',
    category: 'Computer Science',
    tags: 'algorithms, complexity, sorting',
    summary:
      'An algorithm specifies a method, while its data structures and input shape determine how much time and memory that method needs.',
    question: 'Which repeated operation dominates as the input grows?',
    example:
      'Compare checking every product for a category with consulting a category index, then include the cost of maintaining that index during edits.',
    sections: [
      'An algorithm is a precise procedure for solving a class of problems. Its quality depends on correctness first, then on the resources needed under relevant conditions. Two methods may produce the same result while performing very different amounts of work. Counting important operations often reveals more than comparing one short run whose duration is dominated by startup or measurement noise.',
      'Complexity describes growth rather than a universal stopwatch reading. A linear scan examines a number of elements proportional to the input size. A balanced search structure can narrow a lookup through successive decisions. Constants, memory access patterns and the distribution of queries still matter. A simple scan can be the sensible choice for a tiny collection even when another approach has better asymptotic growth.',
      'Data structures express assumptions about access. A sorted sequence helps ordered traversal, a hash table supports equality lookup and a graph represents relationships. Each structure has maintenance costs and constraints. Changing data can make an apparently efficient read path expensive overall. Consider the mix of insertions, updates, deletions and retrieval rather than optimising only the most visible query.',
      'Testing should include empty inputs, repeated values and inconvenient orderings as well as average cases. Performance experiments need comparable inputs and a clear description of what is timed. Separate building a structure from using it, unless the real workload rebuilds it each time. A useful explanation connects the measured behaviour to the operations performed instead of treating a benchmark number as a property independent of context.',
    ],
  },
  {
    title: 'Learning from Data without Memorising It',
    category: 'Artificial Intelligence',
    tags: 'learning, validation, prediction',
    summary:
      'A predictive model must generalise beyond training examples, so representative evaluation and careful treatment of leakage matter as much as fitting.',
    question: 'Would the prediction remain useful on examples collected in a different setting?',
    example:
      'Evaluate a support-ticket classifier on newer customer requests instead of randomly copying near-duplicate messages into both training and test sets.',
    sections: [
      'Machine learning fits patterns from examples instead of encoding every rule by hand. The resulting model may describe genuine structure or exploit accidental shortcuts. A system that performs well on familiar examples has not yet demonstrated useful generalisation. The data collection process, labels and intended deployment conditions are therefore part of the modelling problem rather than details to consider after training.',
      'Training, validation and test sets play different roles. Training adjusts parameters, validation informs choices and a held-out evaluation estimates performance on unseen cases. Repeatedly consulting the test set to choose settings turns it into another development set. Related records must also be separated sensibly: copies from one customer or one photograph can create an illusion of success if they appear on both sides of a split.',
      'Overfitting happens when the model learns details that do not transfer. Simpler models, regularisation and more representative data can help, but no technique repairs a fundamentally misleading evaluation. Accuracy alone may hide rare but important errors. Examine confusion patterns and the consequences of false positives and false negatives, especially when categories are uneven or decisions affect different groups differently.',
      'Deployment introduces change. Customers, devices and language can evolve after the original dataset was collected. Monitoring should compare meaningful outcomes and collect failures that humans can inspect. A prediction score is evidence, not an explanation or a guarantee. Keeping a clear route for correction and documenting the system boundaries makes a modest model more trustworthy than an impressive number with no operational context.',
    ],
  },
  {
    title: 'Designing a Fair Scientific Measurement',
    category: 'Science',
    tags: 'experiments, uncertainty, evidence',
    summary:
      'Useful experiments separate a question from its measurement method and make uncertainty, controls and alternative explanations visible.',
    question: 'What alternative explanation could produce the same observation?',
    example:
      'Compare plant growth under two light conditions while keeping watering, soil and measurement times consistent, and record variation within each group.',
    sections: [
      'A scientific measurement begins with an operational question. Instead of asking whether a plant is healthier, define observable outcomes such as height, leaf count or dry mass. Those outcomes capture different aspects of growth and may not move together. Writing down the method before collecting results helps prevent an attractive observation from silently changing the question being answered.',
      'Controls and comparisons isolate possible causes. If two groups differ in light, water and soil, the final difference cannot be assigned confidently to light alone. Random assignment can reduce some systematic differences, while repeated measurements reveal variation. Neither guarantees perfection. The design should describe what is controlled, what is measured and which factors remain outside the experiment.',
      'Uncertainty is information about the limits of a result. It includes instrument resolution, sampling variation and possible systematic error. Reporting more decimal places does not remove those sources. A graph showing individual measurements may be more informative than one average. When summarising results, keep units visible and explain whether the spread describes observations or uncertainty in an estimated quantity.',
      'Reproducibility depends on enough detail for another person to understand the work. Record materials, timing, exclusions and unexpected events. A result that disagrees with a prediction deserves examination rather than deletion. Distinguish exploratory observations from tests planned beforehand, and prefer conclusions proportional to the evidence. A small careful experiment can establish a useful boundary without claiming to settle every broader question.',
    ],
  },
  {
    title: 'Energy Transfers in Everyday Systems',
    category: 'Physics',
    tags: 'energy, heat, efficiency',
    summary:
      'Energy accounting follows transfers between systems and explains why useful output, heat and storage must be considered together.',
    question: 'Where does the energy go when the useful output appears smaller than the input?',
    example:
      'Compare heating water in an insulated vessel and an open pan, including the vessel, the surrounding air and evaporation in the accounting boundary.',
    sections: [
      'Energy is a quantity used to track physical change. A moving object, a stretched spring and a warmer material can all participate in energy transfers. Choosing the system boundary is essential: an apparent loss from one object may be a gain in its surroundings. Conservation provides an accounting principle, while the mechanisms of transfer explain how the change takes place.',
      'Heat and work describe different ways energy crosses a boundary. Temperature differences can drive thermal transfer, while forces acting through motion can perform work. Temperature itself is not the amount of energy stored in an object; mass and material properties also matter. A small hot object and a large warm object can affect their surroundings very differently.',
      'Efficiency compares a useful output with an input under a stated definition. The word useful depends on the purpose. A lamp intended to illuminate a room treats unwanted heating differently from a heater. Real devices also have standby costs and operating ranges. Comparing efficiencies requires consistent boundaries and comparable conditions, rather than selecting whichever headline figure sounds largest.',
      'Everyday measurements can make the accounting concrete. Record masses, starting temperatures, durations and the energy supplied where possible. Allow for evaporation, heat absorbed by containers and heat transferred to air. The purpose is not to force an exact answer from uncertain observations but to identify the dominant pathways and explain why an ideal calculation differs from an actual kitchen or workshop result.',
    ],
  },
  {
    title: 'Waves Connect Sound and Light',
    category: 'Physics',
    tags: 'waves, sound, light',
    summary:
      'Wave descriptions link frequency, wavelength and propagation while preserving important differences between sound, water waves and light.',
    question: 'Which part of the wave behaviour depends on the medium and which part follows the source?',
    example:
      'Compare a musical note heard across a room with ripples crossing water, and separate vibration at one location from the movement of the disturbance.',
    sections: [
      'A wave transports a disturbance through space without requiring all the material to travel with it. Water ripples make this distinction visible, although real water motion is more complicated than a simple drawing. Frequency describes repeated change at a location, wavelength describes spatial repetition and speed relates the two. These quantities provide a shared language across several very different physical systems.',
      'Sound is a mechanical disturbance in a medium such as air, water or a solid. Its speed depends on the medium and conditions. A source sets the rhythm of oscillation, while reflections and absorption change what a listener receives. Loudness and pitch are related to different aspects of the signal. Room geometry can therefore change clarity without changing the note produced by an instrument.',
      'Light is an electromagnetic wave and does not require a material medium. Its interactions with matter include reflection, refraction and absorption. A boundary can change propagation and redirect a beam, while interference arises when wave contributions combine. The shared wave language is useful, but treating light as compressed air or sound as a coloured beam would erase important distinctions.',
      'An experiment needs a clear prediction. Measure echoes in a space, observe ripples around an obstacle or examine how a lens changes an image. Keep the source and observation method consistent, and notice when a simplified model stops matching the details. Good analogies reveal a relationship while stating their limits; they should not turn similarities in equations into claims that every wave behaves identically.',
    ],
  },
  {
    title: 'Reading the Life of a Star',
    category: 'Astronomy',
    tags: 'stars, spectra, astronomy',
    summary:
      'Stellar light carries evidence about temperature, composition and motion, while mass strongly influences how a star evolves.',
    question: 'Which conclusions can be drawn from light alone and which need additional observations?',
    example:
      'Compare the colour and spectrum of two stars while accounting for distance before concluding which one produces more total light.',
    sections: [
      'Stars are distant physical systems studied mainly through the radiation they emit. Brightness in the sky depends on both intrinsic output and distance, so a faint-looking object need not be weak. Colour and spectra provide different evidence. The distribution of light across wavelengths can suggest temperature, while particular absorption features reveal interactions with material in and around the star.',
      'During a long stable stage, nuclear fusion in the core provides energy that eventually leaves the surface. Gravity and internal pressure shape the structure. Mass has a strong influence on the temperature and rate of energy production, which is why stars do not all live equally long. A larger fuel supply does not simply imply a longer lifetime when it is consumed much more rapidly.',
      'As available fuel and internal structure change, stars follow different evolutionary paths. Low- and intermediate-mass stars can shed outer material and leave compact remnants, while sufficiently massive stars may undergo dramatic collapse. These broad patterns are inferred from physical models and observations of many objects at different stages. We cannot watch every stage of one ordinary stellar lifetime directly.',
      'Observational astronomy combines careful measurement with interpretation. Dust can alter apparent colour, instruments have response limits and neighbouring sources can complicate a signal. Multiple observations reduce ambiguity. A useful beginner project compares seasonal visibility and colour without pretending that a small telescope supplies every physical property. Understanding how evidence is obtained is more valuable than memorising a sequence of dramatic stellar endings.',
    ],
  },
  {
    title: 'Finding Planets around Other Stars',
    category: 'Astronomy',
    tags: 'exoplanets, transits, observations',
    summary:
      'Transit and radial-velocity measurements reveal planetary candidates indirectly, each with selection effects and limits on interpretation.',
    question: 'What other process might imitate the signal of a planet?',
    example:
      'Inspect a repeating dip in stellar brightness and ask how its timing, depth and shape differ from a one-off instrument error.',
    sections: [
      'A planet near a distant star is difficult to observe because the star is bright and the apparent separation is small. Many discoveries therefore rely on indirect effects. A transit slightly reduces the light received when a planet crosses in front of its host from our viewpoint. The method requires a favourable alignment; a system can contain planets that never produce observable transits from Earth.',
      'Repeated transit measurements constrain timing and the size ratio between planet and star. Interpretation depends on knowing the star, and a brightness dip alone is not a complete planetary portrait. Other configurations can imitate part of the signal. Follow-up observations and checks for contamination help distinguish a plausible candidate from an unsupported conclusion based on one attractive pattern.',
      'Radial-velocity observations look for periodic motion of the star along the line of sight. A star and planet orbit a shared centre of mass, and spectral shifts can reveal the stellar motion. Activity on the star can complicate the measurement. Combining methods provides stronger constraints than treating one technique as an infallible detector of every planet in a system.',
      'Atmospheric observations are especially demanding. Small changes in light may carry information about molecules, but clouds, instrumental effects and model assumptions influence interpretation. A planet being in a temperate orbital region does not establish that it has life or even a suitable surface. Clear language separates detection, estimated properties and speculation, leaving room for exciting questions without converting possibilities into established facts.',
    ],
  },
  {
    title: 'Photosynthesis Links Leaves and Atmosphere',
    category: 'Biology',
    tags: 'plants, photosynthesis, ecosystems',
    summary:
      'Photosynthesis captures light energy and builds organic material, while plant growth also depends on water, nutrients and environmental conditions.',
    question: 'Why does more light not always produce more growth?',
    example:
      'Compare plants receiving different light while tracking water availability and leaf condition instead of attributing every difference to sunlight.',
    sections: [
      'Plants use photosynthesis to capture energy from light and support the production of organic molecules. Chloroplasts contain specialised structures for these processes. A simplified equation is useful for bookkeeping, but it compresses many linked reactions into one line. Understanding the mechanism requires distinguishing light-driven reactions from the carbon-fixing processes that use their products.',
      'Leaves exchange gases through small openings and manage a balance between acquiring carbon dioxide and losing water. The conditions around a leaf therefore matter. Temperature, humidity and light influence the balance, while roots supply water and mineral nutrients. A plant cannot solve every shortage by receiving more sunlight; another limiting factor can constrain growth or damage tissues.',
      'Organic material produced by plants supports food webs and contributes to carbon cycling. Some carbon returns rapidly through respiration and decomposition, while some remains stored for longer in wood, soils or other reservoirs. An ecosystem is not a sealed jar. Tracking carbon requires attention to transfers across boundaries and to timescales rather than assuming that green growth automatically equals permanent carbon storage.',
      'Practical observations should connect structure with function. Compare leaf shapes, shaded and exposed positions or changes through a season. A controlled growing experiment can be informative, but height alone is an incomplete measure of plant performance. Record leaf condition, water treatment and timing. Distinguish short-term response from lasting adaptation and avoid drawing universal conclusions from one species on a windowsill.',
    ],
  },
  {
    title: 'Microbes Build Hidden Communities',
    category: 'Biology',
    tags: 'microbes, ecology, decomposition',
    summary:
      'Microbial communities transform nutrients, interact with larger organisms and respond to conditions that are invisible in a simple species list.',
    question: 'How does a change in conditions alter what the community does?',
    example:
      'Compare decomposition in a well-aerated compost heap with a waterlogged one, keeping safety and the limits of observation explicit.',
    sections: [
      'Microbes include diverse organisms with very different ways of living. Some use oxygen, some thrive where it is scarce, and others obtain energy through specialised chemical pathways. Small size does not imply a simple ecological role. Communities in soils, water and living hosts influence nutrient cycles and the availability of resources to many larger organisms.',
      'A list of detected organisms is only part of the picture. Abundance, activity and interactions matter, and laboratory methods can favour organisms that grow under the chosen conditions. DNA-based observations answer different questions from direct measurements of a process. Combining methods helps separate the presence of a potential participant from evidence that it is carrying out a particular transformation.',
      'Decomposition illustrates the dependence on context. Moisture, temperature, oxygen and available material change the pace and products of microbial activity. A compost heap is therefore a managed environment, not merely a pile waiting for one kind of bacterium. Mixing, drainage and the balance of materials can affect whether decomposition proceeds as intended without requiring an invented miracle additive.',
      'Microbes also form relationships with plants and animals, ranging from beneficial associations to disease. It is misleading to label the entire microbial world as either helpful or harmful. Safe study relies on established methods and avoids culturing unknown samples casually. Educational observations can examine published data and ordinary environmental processes while keeping claims proportional to what the measurements actually demonstrate.',
    ],
  },
  {
    title: 'River Cities and the History of Trade',
    category: 'History',
    tags: 'cities, trade, rivers',
    summary:
      'River access shaped transport and settlement, but political institutions, labour and changing technology also determined which cities prospered.',
    question: 'Which evidence separates a convenient geographical story from an explanation of actual change?',
    example:
      'Compare a historic waterfront map with records of markets and bridges, asking who moved goods and who controlled access to the route.',
    sections: [
      'Rivers offered routes for people and goods before modern road and rail networks. Settlements near crossings, sheltered harbours or navigable stretches could gain practical advantages. Geography alone did not decide their future. Flooding, seasonal water levels and the cost of maintaining access could also constrain activity, so the same river could provide opportunity and risk.',
      'Trade required institutions as well as boats. Rules about markets, tolls and property influenced who could participate and how goods moved. Warehouses, workshops and financial services supported exchange, while labourers carried out work often missing from grand accounts of merchants. A history of a waterfront should examine these relationships rather than treating impressive buildings as a complete explanation of prosperity.',
      'Changes in technology shifted the value of old routes. Larger vessels, canals, railways and industrial production altered connections between places. Some districts adapted while others lost their earlier role. Tracing change requires dates and comparisons: a structure visible today may belong to a later phase than the event being explained. Maps and written records should be read together.',
      'Sources reflect particular viewpoints. A city account, a traveller description and an archaeological find each reveal something while leaving other experiences unclear. Historians compare evidence and mark uncertainty rather than filling every gap with a neat narrative. Visiting a riverside city can become an exercise in asking how transport, authority and ordinary work shaped the landscape that survives.',
    ],
  },
  {
    title: 'How Rivers Shape Landscapes',
    category: 'Geography',
    tags: 'rivers, erosion, landscapes',
    summary:
      'Water movement, sediment and changing boundaries interact to produce river channels, floodplains and landscapes that continue to evolve.',
    question: 'What changes when the river has more water, more sediment or less room to move?',
    example:
      'Observe a bend from a safe public path and compare deposition on the inner bank with the shape of the outer bank after different flows.',
    sections: [
      'A river carries water and sediment through a landscape. Its behaviour depends on gradient, flow, material and the boundaries imposed by geology or engineering. A channel drawn as a fixed line on a map hides continuing change. Seasonal variation and occasional large flows can do very different kinds of work, and the most visible day is not necessarily representative of the long-term pattern.',
      'Erosion and deposition redistribute material rather than simply carving everything deeper. Flow conditions vary across a channel, particularly around bends. Sediment sizes also behave differently: fine particles can remain suspended while larger material needs stronger forces to move. A complete explanation considers where material comes from and where it goes, not only the shape at one viewing point.',
      'Floodplains connect the channel with surrounding land. Flooding can distribute sediment and sustain habitats, while also threatening homes and infrastructure built nearby. Levees, straightening and dams change those connections and can shift risk elsewhere. Evaluating a management proposal requires a wider catchment view and attention to who benefits and who bears the consequences.',
      'Field observation should be safe and repeatable. Use established paths, compare photographs from the same location and note weather and recent flow conditions. Do not approach unstable banks to collect a dramatic sample. Maps, aerial imagery and historical records help reveal change over longer periods. A landscape story becomes stronger when it distinguishes measured movement from assumptions based on one picturesque scene.',
    ],
  },
  {
    title: 'Slow Travel by Rail',
    category: 'Travel',
    tags: 'rail, journeys, planning',
    summary:
      'A thoughtful rail journey balances connections, time in places and realistic contingencies instead of maximising the number of destinations.',
    question: 'Which part of the journey becomes better when the itinerary leaves room for uncertainty?',
    example:
      'Plan a three-city rail trip with a spare connection window and compare it with an itinerary that depends on every train arriving exactly on time.',
    sections: [
      'Travel planning is an exercise in choosing attention. A route with many stops may look rich on a map while leaving little time to understand any place. Rail travel can make the journey itself part of the experience, but connections, luggage and station access still require thought. A comfortable pace begins with the needs of the travellers rather than a list of landmarks.',
      'A timetable is useful information rather than a promise that every condition remains unchanged. Reservation rules, engineering work and local transport differ between routes. Check the relevant operators before booking and leave a practical margin where missing one train would disrupt the whole day. Keeping essential details available offline helps when a phone battery or network connection fails.',
      'Staying longer changes what becomes possible. A repeated walk reveals different activity at different times, and one museum visit can lead to questions explored in a nearby neighbourhood. Local meals and everyday transport provide context when approached respectfully. The aim is not to claim authenticity from one encounter but to notice how residents use the place beyond the visitor route.',
      'Responsible travel includes its effects on other people and the environment. Compare actual routes and occupancy when discussing transport impacts instead of treating one label as a universal answer. Respect residential quiet, access rules and local guidance. A useful itinerary has alternatives for weather, fatigue and accessibility, allowing curiosity to survive the ordinary unpredictability of being away from home.',
    ],
  },
  {
    title: 'Wetlands as Living Water Systems',
    category: 'Nature',
    tags: 'wetlands, habitats, water',
    summary:
      'Wetlands connect water, vegetation and wildlife, with ecological functions that depend on seasonal conditions and landscape connections.',
    question: 'Which connections must remain intact for the habitat to keep functioning?',
    example:
      'Observe birds, vegetation zones and water levels from a boardwalk across several visits without disturbing nests or entering sensitive ground.',
    sections: [
      'Wetlands occur where water strongly shapes soil and living communities. Marshes, peatlands and seasonally flooded areas differ, so the word does not describe one uniform habitat. Water depth, duration, chemistry and movement influence which plants and animals can thrive. Seasonal change is part of many wetland systems rather than a failure of the landscape to remain constant.',
      'Vegetation creates structure for feeding, shelter and reproduction. Shallow water, reed beds and open patches support different activities. Birds can be conspicuous, but insects, microbes and submerged plants also participate in the system. Observing one species does not fully describe habitat quality. Look for relationships between water conditions, vegetation and the use of space over time.',
      'Wetlands can store water, retain material and influence carbon cycles, but their functions depend on local conditions. Draining, isolating or contaminating them changes those processes. Restoring water connections can be more important than planting a decorative strip at the edge. Management choices also interact with farming, flood protection and access, requiring a clear account of competing needs.',
      'Visitors can learn a great deal from designated viewpoints. Quiet behaviour, binoculars and repeated notes reduce disturbance and improve observation. Keep dogs controlled where required and avoid approaching nests for photographs. Conservation claims should identify the habitat, the intervention and the evidence of response. A thriving-looking scene on one day is encouraging, but long-term records reveal whether the system remains resilient.',
    ],
  },
  {
    title: 'Bridges Balance Forces and Materials',
    category: 'Engineering',
    tags: 'bridges, structures, design',
    summary:
      'Bridge design moves loads through a structure to its supports while accounting for material behaviour, use, inspection and maintenance.',
    question: 'How does each design carry a load to the ground?',
    example:
      'Compare a beam, an arch and a suspension bridge on diagrams, following the load path rather than judging strength from appearance.',
    sections: [
      'A bridge provides a route across an obstacle while transferring loads to supports. Its shape is not only an aesthetic choice: beams, arches, trusses and cables carry forces differently. Following the load path explains why an apparently slender element can be useful and why support conditions matter. The entire structure works as a connected system rather than a collection of independent strong pieces.',
      'Materials respond differently to tension, compression, bending and repeated loading. Steel, concrete and timber each have advantages and constraints. Connections are especially important because they transfer forces between elements. A sound design considers deformation as well as failure, since excessive movement can make a structure uncomfortable or damage attached surfaces before the main members reach their strength limits.',
      'Loads include more than the weight of a vehicle standing still. Wind, temperature change, moving traffic and the structure own weight influence behaviour. Foundations interact with soil and water, and flood conditions can threaten supports. Engineers use models, standards and investigation to estimate these effects, then build margins appropriate to uncertainty and the consequences of failure.',
      'Inspection and maintenance continue the design process after opening. Drainage, corrosion protection and access to critical details affect service life. A public observer can compare forms safely from paths, but should not infer structural condition from one photograph. Educational models demonstrate ideas on a small scale; they are not instructions for constructing a real crossing without professional design and approval.',
    ],
  },
  {
    title: 'Rhythm Gives Music a Sense of Motion',
    category: 'Music',
    tags: 'rhythm, listening, performance',
    summary:
      'Pulse, grouping and phrasing create musical motion, while performers can shape timing without losing a shared structure.',
    question: 'What changes when an accent moves while the underlying pulse remains steady?',
    example:
      'Clap a steady pulse, speak a short phrase over it and compare the effect of stressing different syllables without increasing the tempo.',
    sections: [
      'Rhythm organises events in time. A regular pulse helps listeners predict movement, while patterns of duration and accent create interest around it. Not all music uses a constant beat, and a written time signature is not the whole experience of rhythm. Listening for repetition and change gives a practical starting point before introducing notation or specialised vocabulary.',
      'Grouping lets several beats feel like a larger unit. Accents can reinforce that grouping or work against it, producing tension and release. Silence also participates: a pause can prepare an entrance or make an existing pattern clearer. The same sequence of pitches can feel different when durations, emphasis and gaps change, showing why rhythm is more than a background metronome.',
      'Ensemble performance requires coordination, but exact mechanical alignment is not always the artistic goal. Players listen to one another and shape timing according to style and phrase. Small variations can feel expressive when the relationship remains coherent. Teaching should distinguish an intentional choice from an unstable pulse without assuming that one cultural tradition supplies the rules for every kind of music.',
      'Simple exercises connect analysis with experience. Tap a pulse, layer a contrasting pattern and record a short performance for comparison. Slow practice reveals where coordination becomes difficult, while listening to several interpretations shows alternative phrasing. Use comfortable volume levels and pauses when practising. A good discussion describes what is heard and how it changes, rather than ranking styles by an invented universal standard.',
    ],
  },
  {
    title: 'Endurance Training Is a Balance',
    category: 'Sports',
    tags: 'endurance, recovery, exercise',
    summary:
      'Sustainable endurance practice combines manageable effort, recovery and gradual adaptation rather than treating every session as a competition.',
    question: 'How can a training record distinguish useful progress from accumulating fatigue?',
    example:
      'Compare two fictional runners with equal weekly distance but different distributions of easy days, hard efforts and rest.',
    sections: [
      'Endurance activity asks the body to sustain effort over time. Running, cycling and swimming differ in technique and impact, but all involve pacing and adaptation. Fitness is not one number, and a faster session can reflect weather, terrain or short-term motivation as well as lasting improvement. A useful training description records conditions and the purpose of the activity.',
      'Adaptation occurs through a combination of stimulus and recovery. Increasing every session at once can make it difficult to identify what caused fatigue or discomfort. Gradual changes and easy work provide a basis for consistency. Individual history matters, so an example schedule is an illustration of planning principles rather than a prescription for every age, experience level or health condition.',
      'Pacing influences whether an effort remains controlled. Starting too quickly may produce an impressive first section and a much slower finish. On varied terrain, effort and speed are not equivalent. Recording perceived effort alongside distance and time can help interpret changes. Recovery days are part of the plan rather than evidence that an athlete has failed to work hard enough.',
      'Training records should support reflection without turning every ordinary variation into a verdict. Look for trends over comparable conditions and note sleep, schedule and interruptions. Persistent pain or unusual symptoms require appropriate professional advice rather than an improvised adjustment from a demo article. The transferable lesson is a careful relationship between observation, gradual change and enough rest to make consistent participation possible.',
    ],
  },
  {
    title: 'Fermentation Changes Food through Microbes',
    category: 'Food',
    tags: 'fermentation, cooking, microbes',
    summary:
      'Fermentation transforms ingredients through microbial activity, and reliable recipes control conditions rather than relying on appearance alone.',
    question: 'Which controlled condition makes the process predictable and safe?',
    example:
      'Compare how a tested bread recipe uses yeast, time and temperature with the different controls required by a vegetable fermentation recipe.',
    sections: [
      'Fermentation is a family of processes in which microbes transform ingredients. Bread, yoghurt and fermented vegetables involve different organisms and conditions, so they should not be treated as interchangeable experiments. Flavour, texture and gas production emerge from specific interactions. A familiar traditional food can still require careful preparation and storage to reproduce reliably in a different kitchen.',
      'Temperature, time, acidity and ingredient proportions influence which organisms grow and what they produce. Salt in some vegetable processes does more than season the food, while a starter culture can guide another process. These controls belong to a tested method. Changing several ingredients casually can alter safety as well as flavour, and visible bubbling alone is not proof that a product is safe to eat.',
      'Bread offers an accessible example of observing a controlled process. Dough structure traps gas, while fermentation changes flavour and behaviour. Rising depends on temperature and the condition of the starter or yeast, not only the clock. Comparing doughs made with one carefully varied factor can reveal relationships without turning the kitchen into a random mixture of unknown cultures.',
      'Use reliable food-safety guidance and tested recipes for practical preparation. Keep equipment clean, follow storage instructions and discard food when guidance indicates a problem; tasting is not a safe test for uncertain preservation. Educational discussion can examine the roles of microbes and conditions without supplying unsupported preservation instructions. Careful notes help distinguish a reproducible improvement from a lucky batch that cannot be explained.',
    ],
  },
  {
    title: 'Museums Tell Stories through Objects',
    category: 'Culture',
    tags: 'museums, interpretation, objects',
    summary:
      'Museum displays select, arrange and describe objects, making interpretation and provenance central to the visitor experience.',
    question: 'Whose viewpoint is visible in the display and whose remains outside it?',
    example:
      'Compare two labels for the same historical object, one focused on craftsmanship and the other on the circumstances of its collection.',
    sections: [
      'An object in a museum has more than one possible story. Material, craftsmanship, use and later ownership can each guide interpretation. The display chooses which details to emphasise and which comparisons visitors can make. A label is therefore not a neutral container holding every fact; it is a short argument shaped by evidence, space and the intended audience.',
      'Provenance traces where an object came from and how it changed hands. Gaps and disputed histories matter, especially when collection involved unequal power or unclear consent. Responsible interpretation marks those questions rather than hiding them behind a beautiful case. The object physical condition and the records attached to it may provide different kinds of evidence that need to be considered together.',
      'Arrangement changes meaning. Placing objects by date suggests development over time, while grouping by material or use invites another comparison. Lighting and accessibility affect who can examine the display comfortably. Audio, tactile and written interpretation can complement one another when designed thoughtfully. More information is not always better if visitors cannot find a clear route through it.',
      'A rewarding visit can focus on a few objects rather than covering every room. Observe first, read the label, then ask what remains uncertain. Compare the account with another display or a catalogue when available. Respect photography and access rules. Museums become especially interesting when visitors recognise that interpretation is an ongoing conversation involving communities, researchers and the changing questions people bring to collections.',
    ],
  },
  {
    title: 'Solar Power as a Community Project',
    category: 'Engineering',
    tags: 'solar, energy, communities',
    summary:
      'A community solar project combines site conditions, electrical design, maintenance and shared decisions about costs and benefits.',
    question: 'Does the proposed system match the pattern of demand and the responsibilities of its owners?',
    example:
      'Compare two fictional roofs with different shading and daytime use before deciding which one supports the more useful installation.',
    sections: [
      'Solar panels convert incoming light into electrical energy, but an installation is more than a panel rating. Roof orientation, shading, temperature and available area influence production. A number measured under standard test conditions is a reference rather than a promise of output at every moment. Local weather patterns and the intended use determine what a realistic production estimate means.',
      'Electrical components connect production with usable power and appropriate protection. Inverters, wiring and monitoring need to match the system design. Batteries change when energy can be used, while adding cost, losses and maintenance considerations. A community should define the problem first: reducing daytime purchases, supporting a shared building or another goal may lead to different choices.',
      'Ownership arrangements shape the project as strongly as hardware. Participants need clear rules for payments, maintenance, decision-making and the distribution of benefits. A technically sound installation can still disappoint if expectations are vague. Explain assumptions about prices and usage, test less favourable scenarios and avoid presenting one forecast as a guaranteed financial outcome.',
      'Implementation requires qualified assessment and compliance with local electrical and building requirements. Educational comparison can explore shading, demand patterns and shared governance without pretending to replace professional design. Keep records of inspections and actual production, then compare them with the original assumptions. Learning from operation makes the project more accountable and helps future decisions reflect observed conditions rather than an attractive brochure.',
    ],
  },
];

type Perspective = { title: string; introduction: string; discussion: (topic: ArticleTopic) => string };

const ARTICLE_PERSPECTIVES: Perspective[] = [
  {
    title: 'a practical introduction',
    introduction:
      'The clearest introduction starts with a familiar situation and makes the mechanism visible before adding specialised vocabulary. This article separates the underlying process, a concrete example and the limits of the explanation. It is intended for a reader who wants enough context to ask better questions, not merely a collection of terms to memorise. Each section follows one relationship and connects it with the next.',
    discussion: (topic) =>
      `A worked example\n${topic.example} Start by listing what can be observed directly and what has to be inferred. Make a prediction before looking at the result, then compare it with what actually happens. If the explanation fails, identify which assumption changed instead of replacing the whole account with a new slogan.\n\nA beginner can use a small diagram or a written sequence to keep the relationships clear. Label the important parts, add units where relevant and mark any step that depends on unavailable evidence. This approach makes an unfamiliar topic manageable without claiming that the simplified picture captures every detail. The aim is a useful first model that can be refined as more information becomes available.\n\nThe next question is: ${topic.question} Answering it requires returning to the specific example. A short explanation supported by one careful comparison is often more helpful than a long list of disconnected facts. Keep the observation, the interpretation and the remaining uncertainty visible to another reader.`,
  },
  {
    title: 'evidence and measurement',
    introduction:
      'An explanation becomes stronger when a reader can see the evidence behind it. This article examines the mechanism and then asks how an observation could support or challenge the account. Measurement is treated as a design choice with limits, not as a machine that produces certainty automatically. The same question can require several kinds of evidence before a useful conclusion is justified.',
    discussion: (topic) =>
      `Designing the comparison\n${topic.example} Decide which observation would distinguish the main explanation from an alternative. Keep the comparison narrow enough to interpret, and record conditions that might change the outcome. Repeating a measurement can reveal variation, but repeated use of a biased method does not remove its bias.\n\nSeparate resolution from reliability. A detailed table is useful only if its values describe the intended quantity and its collection method is understandable. Where direct measurement is impossible, state what proxy is used and why it is relevant. Do not hide missing information by averaging incompatible observations together. A simple record with clear units and contextual notes often supports more honest reasoning than an elaborate chart without a method.\n\nThe central question remains: ${topic.question} Use the available evidence to answer a bounded version of that question. State what was observed, what was inferred and what another investigation would need to establish. An uncertain result can still be informative when the uncertainty is described rather than disguised.`,
  },
  {
    title: 'trade-offs and design choices',
    introduction:
      'Many useful systems are shaped by compromises rather than one universally best choice. This article introduces the process and compares the benefits of a decision with its costs under a stated purpose. A design should be assessed in the conditions where it will be used. Changing the goal or constraints can change the preferred option even when the underlying principles remain the same.',
    discussion: (topic) =>
      `Choosing under constraints\n${topic.example} Describe the purpose before selecting a preferred approach. Consider time, resources, reliability and the consequences of error. An option that performs well under ideal conditions may require more maintenance or leave less room for an unexpected change. Another option may look less impressive while being easier to understand and operate consistently.\n\nCompare alternatives using the same boundary. Include preparation and follow-up work if those activities belong to the real task. Make assumptions explicit, especially when one option shifts effort or risk onto another person. A short decision table can expose what is being valued and which information is missing. It should support judgement rather than pretend to convert every important consideration into one unquestionable score.\n\nAsk again: ${topic.question} The answer should explain why a choice fits this situation and when a different choice would make sense. A robust decision includes a way to notice changed conditions and revise the plan, rather than treating the first selection as permanent proof of superiority.`,
  },
  {
    title: 'a classroom investigation',
    introduction:
      'A classroom investigation works best when learners can make a prediction, compare evidence and explain a revision. This article introduces the topic through that sequence. It favours a small understandable activity over a dramatic demonstration whose important details remain hidden. The goal is to connect observation with reasoning while making safe methods and the limits of any model clear.',
    discussion: (topic) =>
      `From prediction to discussion\n${topic.example} Ask learners to write a prediction individually before discussing it. Different predictions reveal which assumptions need attention and give the later comparison a purpose. Choose an observation method that can be described clearly, and avoid treating the instructor explanation as evidence in itself.\n\nSmall groups can share responsibilities for notes, timing and checking the method. Keep raw observations available instead of recording only the final summary. During discussion, distinguish disagreement about a measurement from disagreement about its meaning. Both can be useful. An activity does not have to produce the expected result to support learning if the group can identify an uncontrolled factor or a mistaken assumption.\n\nClose by asking: ${topic.question} Each group should connect its answer to a specific observation and name one remaining limitation. A follow-up task can change one condition or examine another source of evidence. That structure encourages understanding beyond reproducing the vocabulary of the first demonstration.`,
  },
  {
    title: 'common misconceptions',
    introduction:
      'A memorable phrase can help explain a topic and still create a misleading shortcut. This article presents the core process before examining how an apparently simple account can go wrong. Correcting a misconception requires more than saying that it is false: the reader needs a replacement explanation that fits familiar observations and makes its own boundaries clear.',
    discussion: (topic) =>
      `Checking an attractive shortcut\n${topic.example} Listen for a conclusion that moves too quickly from one observation to a general rule. Ask what has been assumed about conditions, scale or purpose. A useful correction shows why the shortcut seemed reasonable, then provides a comparison where it gives the wrong expectation.\n\nAvoid replacing one absolute claim with another. The original idea may work within a narrow setting even though it fails elsewhere. Mark that setting explicitly and introduce the missing relationship. Diagrams and carefully chosen counterexamples can make the difference easier to see than a definition alone. Give readers time to use the corrected explanation on a fresh case rather than only repeating the instructor preferred wording.\n\nReturn to the question: ${topic.question} A satisfactory answer should distinguish a valid simplification from a claim that exceeds its evidence. Knowing when an idea applies is part of understanding it. The most useful outcome is a reader who recognises the shortcut independently and can explain which detail changes the conclusion.`,
  },
  {
    title: 'change over time',
    introduction:
      'A single observation can conceal a process that develops over minutes, seasons or generations. This article explains the topic with attention to timescale. It separates short-term variation from sustained change and asks which records make that distinction possible. The best comparison depends on the pace of the process and on whether conditions remain comparable between observations.',
    discussion: (topic) =>
      `Following a sequence\n${topic.example} Record a starting condition and a series of later observations using the same method where practical. Note interruptions and changes in context instead of assuming every difference belongs to one trend. A sequence can reveal delays, cycles or thresholds that are invisible in a single before-and-after picture.\n\nChoose the interval to match the question. Frequent records can miss a slow underlying shift if the total observation period is too short, while sparse records can overlook brief important events. Compare similar conditions when interpreting change, and resist selecting only the beginning and ending points that support a preferred story. Keep the history of the method itself available when equipment or definitions change.\n\nThen ask: ${topic.question} The answer may differ at different stages of the process. Explain which timescale the evidence supports and which future behaviour remains uncertain. This makes a trend a reasoned account rather than a prediction drawn automatically from the shape of a line.`,
  },
  {
    title: 'systems and connections',
    introduction:
      'A topic often becomes clearer when it is viewed as part of a connected system. This article follows relationships between components instead of treating each detail as an isolated fact. It asks what crosses a boundary, what feedback changes later behaviour and what happens when one connection is removed. The system picture remains a model whose scope needs to be stated.',
    discussion: (topic) =>
      `Drawing the relationships\n${topic.example} Sketch the participants and draw arrows for the relevant transfers or influences. Give each arrow a meaning; an unlabeled connection can hide several different mechanisms. Decide what belongs inside the system and what is treated as an external condition for this investigation.\n\nLook for dependence as well as direct action. A component can matter because it enables another process, stores something for later or limits the rate of change. Removing one part may shift behaviour elsewhere rather than simply reducing the total by a fixed amount. Check those claims against evidence and avoid assuming that every connected diagram must contain a self-correcting feedback loop.\n\nThe guiding question is: ${topic.question} Answer it using the relationships in the diagram, then test whether the chosen boundary leaves out something essential. A useful system account can explain where a local improvement creates a distant cost and why a decision should sometimes be assessed over a wider setting.`,
  },
  {
    title: 'responsible decisions',
    introduction:
      'Applying knowledge changes the conditions experienced by other people and environments. This article explains the topic and then examines how a decision can remain accountable to those effects. Responsibility involves clear evidence, realistic claims and an understanding of who bears uncertainty. It is more useful to specify safeguards and limits than to describe an appealing outcome without its costs.',
    discussion: (topic) =>
      `Considering consequences\n${topic.example} Identify who benefits from the decision and who might experience inconvenience, cost or risk. Include people whose role is easy to overlook. Consult relevant expertise where an action requires it, and distinguish an educational example from authority to carry out a real intervention.\n\nState the uncertainty in language a participant can understand. An optimistic estimate should not be presented as a guarantee, and a lack of visible harm is not evidence that no effect exists. Compare less favourable conditions and plan how concerns will be reported. Where local rules, safety standards or consent apply, they belong in the decision from the start rather than as a final administrative step.\n\nNow ask: ${topic.question} A responsible answer explains both the reasoning and the limits of the proposed action. It should include a way to review the outcome and correct a mistake. That makes the decision a continuing obligation supported by observation, rather than a one-time claim that good intentions are sufficient.`,
  },
  {
    title: 'an observation notebook',
    introduction:
      'A notebook preserves the details that memory tends to simplify. This article introduces the topic and shows how useful notes connect a question with observations, interpretations and unresolved points. The method can support a field visit, a workshop or a reading project. It does not require elaborate equipment, but it does require a consistent distinction between evidence and expectation.',
    discussion: (topic) =>
      `Making the record useful\n${topic.example} Begin each entry with the question and enough context to compare it with another occasion. Include dates, conditions and the method where relevant. Write direct observations separately from the explanation you currently favour. A sketch or photograph can help, provided it has a label explaining what it is intended to show.\n\nRecord surprises and unsuccessful attempts rather than keeping only the entries that look polished. They can reveal limits of the method and prevent someone else from repeating the same assumption. When returning to the notes, compare what changed and what stayed consistent. A summary should point back to particular entries so that another reader can follow the reasoning.\n\nUse the question as a check: ${topic.question} Which note helps answer it, and which missing detail prevents a stronger conclusion? The notebook becomes valuable when it supports that conversation. Its purpose is not to collect the maximum number of facts but to preserve the relationships needed for a careful interpretation later.`,
  },
  {
    title: 'comparing two approaches',
    introduction:
      'Comparison turns an abstract principle into a concrete decision. This article explains the topic and then develops a fair way to compare two approaches. It pays attention to the purpose, the starting conditions and the work hidden outside the most visible result. A useful comparison can show where both options succeed and where each has a different limitation.',
    discussion: (topic) =>
      `A fair side-by-side study\n${topic.example} Define the outcome before judging the options. Keep common conditions aligned where possible and explain differences that cannot be controlled. Include the effort required to prepare, operate and maintain each approach if it belongs to the intended use. Otherwise one option may appear superior only because part of its work has been left outside the comparison.\n\nUse more than one relevant case. An approach suited to ordinary conditions may perform differently under a rare but important constraint. Record both successful and unsuccessful outcomes and avoid choosing examples only after seeing which result supports a preference. Where values or priorities differ, describe them openly instead of claiming that one score can settle every disagreement.\n\nFinally ask: ${topic.question} The conclusion should state which approach fits the current purpose and what would change that judgement. A fair comparison leaves the reader with an explanation they can adapt to another situation, rather than a permanent ranking disconnected from the conditions that produced it.`,
  },
];

export function generateDemoArticles(count = SHOWCASE_DEFAULT_COUNTS.articles): ShowcaseDocument[] {
  checkCount(count);
  return Array.from({ length: count }, (_, index) => {
    const topic = ARTICLE_TOPICS[index % ARTICLE_TOPICS.length];
    const perspective = ARTICLE_PERSPECTIVES[Math.floor(index / ARTICLE_TOPICS.length) % ARTICLE_PERSPECTIVES.length];
    const body = [
      topic.summary,
      perspective.introduction,
      ...topic.sections.map(
        (section, sectionIndex) =>
          `${['The central process', 'How the parts interact', 'A wider context', 'Interpreting the evidence'][sectionIndex]}\n${section}`,
      ),
      perspective.discussion(topic),
      `Conclusion\n${topic.question} The discussion has connected a mechanism with a concrete situation and a way to examine it. Keep the scope of the explanation visible when using it elsewhere. New evidence may refine a detail without making every earlier observation useless. This article is authored educational material for the demonstration database; it is not a substitute for specialised advice, a live reference or a claim that every question about the topic has been resolved.`,
    ].join('\n\n');
    return {
      id: documentId('article', index),
      title: `${topic.title}: ${perspective.title}`,
      summary: `${topic.summary} Focus: ${perspective.title}.`,
      category: topic.category,
      author: ['Mira Vermeer', 'Jonas Dubois', 'Clara Peeters', 'Sam Leclercq'][
        Math.floor(index / ARTICLE_TOPICS.length) % 4
      ],
      publishedAt: `2026-${String(1 + (Math.floor(index / 28) % 9)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')}`,
      tags: `${topic.tags}, ${perspective.title}`,
      body,
    };
  });
}

/** Shared by temporary demos and the standalone persistent showcase script. */
export function generateShowcaseCollections(counts: Partial<ShowcaseCounts> = {}): ShowcaseCollection[] {
  const selected = { ...SHOWCASE_DEFAULT_COUNTS, ...counts };
  for (const count of Object.values(selected)) checkCount(count);
  const products = generateDemoProducts(selected.products);
  return [
    { name: 'employees', documents: generateDemoEmployees(selected.employees), unindexedFields: [] },
    { name: 'products', documents: products, unindexedFields: ['description', 'supplierNote'] },
    { name: 'orders', documents: generateDemoOrders(products, selected.orders), unindexedFields: [] },
    { name: 'knowledge', documents: generateSemanticKnowledgeDemoDocuments(), unindexedFields: ['body'] },
    {
      name: 'articles',
      documents: generateDemoArticles(selected.articles),
      unindexedFields: ['summary', 'tags', 'body'],
      compressionDefaults: { body: 'gzip' },
    },
    {
      name: 'travel_guides',
      documents: generateDemoTravelGuides(selected.travel_guides),
      unindexedFields: ['summary', 'body'],
      compressionDefaults: { body: 'gzip' },
    },
    {
      name: 'support_tickets',
      documents: generateDemoSupportTickets(selected.support_tickets),
      unindexedFields: ['description', 'resolution'],
      compressionDefaults: { description: 'gzip', resolution: 'gzip' },
    },
  ];
}
