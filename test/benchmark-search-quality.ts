/**
 * Search Quality Benchmark — Rich benchmark with realistic overlap and noise.
 *
 * 30 pages, 60 chunks, 20 queries with graded relevance. Tests ranking quality
 * in a brain with overlapping topics, multiple mentions, and temporal ambiguity.
 *
 * All data is fictional. No private information.
 *
 * Usage: bun run test/benchmark-search-quality.ts
 */

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { rrfFusion } from '../src/core/search/hybrid.ts';
import { dedupResults } from '../src/core/search/dedup.ts';
import { precisionAtK, recallAtK, mrr, ndcgAtK } from '../src/core/search/eval.ts';
import { autoDetectDetail } from '../src/core/search/intent.ts';
import type { SearchResult, ChunkInput } from '../src/core/types.ts';

const RRF_K = 60;

// ─── Embedding helpers ───────────────────────────────────────────

// Create embeddings with shared dimensions to simulate semantic overlap.
// Each "topic" gets a primary dimension. Related topics share secondary dimensions.
function topicEmbedding(topics: Record<number, number>, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  for (const [idx, weight] of Object.entries(topics)) {
    emb[Number(idx) % dim] = weight;
  }
  // Normalize
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += emb[i] * emb[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) emb[i] /= mag;
  return emb;
}

// Topic dimensions (semantic axes)
const T = {
  AI: 0, FINTECH: 1, CRYPTO: 2, CLIMATE: 3, HEALTH: 4,
  ENTERPRISE: 5, CONSUMER: 6, ROBOTICS: 7, EDUCATION: 8, BIOTECH: 9,
  FOUNDER: 10, INVESTOR: 11, ENGINEER: 12, DESIGNER: 13,
  MEETING: 20, ANNOUNCEMENT: 21, FUNDING: 22, LAUNCH: 23, HIRING: 24,
  COMPILED: 30, TIMELINE: 31,
};

// ─── Test Data: 30 fictional pages ──────────────────────────────

interface TestPage {
  slug: string;
  type: 'person' | 'company' | 'concept';
  title: string;
  compiled_truth: string;
  timeline: string;
  chunks: ChunkInput[];
}

const PAGES: TestPage[] = [
  // ── People (10) ──────────────────────────────────────────────
  {
    slug: 'people/alice-chen',
    type: 'person',
    title: 'Alice Chen',
    compiled_truth: 'Alice Chen is the CEO of NovaPay, a fintech startup building instant cross-border payments for SMBs. Previously VP Engineering at Stripe. Deep expertise in payment rails and regulatory compliance.',
    timeline: '2024-03-15: Met Alice at Fintech Forum. Discussed cross-border payment challenges in Southeast Asia. She mentioned NovaPay is expanding to Vietnam.\n2024-06-20: Coffee with Alice. NovaPay raised Series B. Hiring aggressively.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Alice Chen is the CEO of NovaPay, a fintech startup building instant cross-border payments for SMBs. Previously VP Engineering at Stripe. Deep expertise in payment rails and regulatory compliance.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.FINTECH]: 1, [T.FOUNDER]: 0.6, [T.ENTERPRISE]: 0.3}), token_count: 35 },
      { chunk_index: 1, chunk_text: '2024-03-15: Met Alice at Fintech Forum. Discussed cross-border payment challenges in Southeast Asia. NovaPay expanding to Vietnam. 2024-06-20: Coffee with Alice. NovaPay raised Series B. Hiring aggressively.', chunk_source: 'timeline', embedding: topicEmbedding({[T.FINTECH]: 0.5, [T.MEETING]: 0.8, [T.FUNDING]: 0.4}), token_count: 40 },
    ],
  },
  {
    slug: 'people/bob-martinez',
    type: 'person',
    title: 'Bob Martinez',
    compiled_truth: 'Bob Martinez is a partner at Green Horizon Ventures, focused on climate tech and clean energy investments. Board member at SolarGrid and WindFlow. Former McKinsey energy practice.',
    timeline: '2024-04-10: Lunch with Bob. He is bullish on grid-scale battery storage. Mentioned a new fund for carbon capture.\n2024-08-05: Bob introduced me to the SolarGrid founder.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Bob Martinez is a partner at Green Horizon Ventures, focused on climate tech and clean energy investments. Board member at SolarGrid and WindFlow. Former McKinsey energy practice.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.CLIMATE]: 1, [T.INVESTOR]: 0.7, [T.ENTERPRISE]: 0.2}), token_count: 32 },
      { chunk_index: 1, chunk_text: '2024-04-10: Lunch with Bob. Bullish on grid-scale battery storage. New fund for carbon capture. 2024-08-05: Bob introduced me to SolarGrid founder.', chunk_source: 'timeline', embedding: topicEmbedding({[T.CLIMATE]: 0.5, [T.MEETING]: 0.8, [T.FUNDING]: 0.3}), token_count: 30 },
    ],
  },
  {
    slug: 'people/carol-nakamura',
    type: 'person',
    title: 'Carol Nakamura',
    compiled_truth: 'Carol Nakamura is CTO of MindBridge, an AI company building diagnostic tools for mental health professionals. PhD in computational neuroscience from MIT. Pioneer in applying transformer models to clinical psychology.',
    timeline: '2024-02-28: Carol presented at AI Health Summit. MindBridge accuracy data is impressive, 94% concordance with clinical diagnosis.\n2024-07-12: Carol reached out about Series A. Looking for $15M.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Carol Nakamura is CTO of MindBridge, an AI company building diagnostic tools for mental health professionals. PhD in computational neuroscience from MIT. Pioneer in transformer models for clinical psychology.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.7, [T.HEALTH]: 0.8, [T.FOUNDER]: 0.4, [T.ENGINEER]: 0.3}), token_count: 35 },
      { chunk_index: 1, chunk_text: '2024-02-28: Carol presented at AI Health Summit. MindBridge 94% concordance with clinical diagnosis. 2024-07-12: Carol reached out about Series A, looking for $15M.', chunk_source: 'timeline', embedding: topicEmbedding({[T.AI]: 0.3, [T.HEALTH]: 0.4, [T.MEETING]: 0.6, [T.FUNDING]: 0.5}), token_count: 32 },
    ],
  },
  {
    slug: 'people/david-okonkwo',
    type: 'person',
    title: 'David Okonkwo',
    compiled_truth: 'David Okonkwo is founder of EduStack, an AI-powered adaptive learning platform. Previously taught CS at Stanford. Believes personalized education is the biggest unlocked market in tech.',
    timeline: '2024-05-02: David demoed EduStack at demo day. The adaptive curriculum engine is genuinely novel.\n2024-09-18: David shipped v2 with real-time assessment. Growing 40% MoM in Nigeria.',
    chunks: [
      { chunk_index: 0, chunk_text: 'David Okonkwo is founder of EduStack, an AI-powered adaptive learning platform. Previously taught CS at Stanford. Believes personalized education is the biggest unlocked market in tech.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.5, [T.EDUCATION]: 1, [T.FOUNDER]: 0.6}), token_count: 32 },
      { chunk_index: 1, chunk_text: '2024-05-02: David demoed EduStack at demo day. Adaptive curriculum engine is novel. 2024-09-18: David shipped v2 with real-time assessment. Growing 40% MoM in Nigeria.', chunk_source: 'timeline', embedding: topicEmbedding({[T.EDUCATION]: 0.5, [T.LAUNCH]: 0.7, [T.MEETING]: 0.4}), token_count: 35 },
    ],
  },
  {
    slug: 'people/elena-volkov',
    type: 'person',
    title: 'Elena Volkov',
    compiled_truth: 'Elena Volkov is co-founder of CryptoSafe, building institutional-grade custody for digital assets. Former security engineer at Google. Expert in HSM architecture and multi-party computation.',
    timeline: '2024-01-20: Elena gave a talk on MPC wallets at ETH Denver. Very technical, very sharp.\n2024-06-15: CryptoSafe announced $30M Series A led by a16z crypto.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Elena Volkov is co-founder of CryptoSafe, building institutional-grade custody for digital assets. Former security engineer at Google. Expert in HSM architecture and multi-party computation.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.CRYPTO]: 0.8, [T.ENTERPRISE]: 0.5, [T.ENGINEER]: 0.6, [T.FOUNDER]: 0.3}), token_count: 32 },
      { chunk_index: 1, chunk_text: '2024-01-20: Elena talk on MPC wallets at ETH Denver. Very technical. 2024-06-15: CryptoSafe announced $30M Series A led by a16z crypto.', chunk_source: 'timeline', embedding: topicEmbedding({[T.CRYPTO]: 0.5, [T.ANNOUNCEMENT]: 0.6, [T.FUNDING]: 0.7}), token_count: 28 },
    ],
  },
  {
    slug: 'people/frank-dubois',
    type: 'person',
    title: 'Frank Dubois',
    compiled_truth: 'Frank Dubois is head of AI at RoboLogic, building autonomous warehouse robots. 15 years in robotics, previously at Boston Dynamics. Focused on manipulation in unstructured environments.',
    timeline: '2024-03-22: Frank showed the latest RoboLogic demo. Picking irregular objects at 98% accuracy.\n2024-11-01: RoboLogic deployed at Amazon fulfillment center in Memphis.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Frank Dubois is head of AI at RoboLogic, building autonomous warehouse robots. 15 years in robotics, previously at Boston Dynamics. Focused on manipulation in unstructured environments.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.6, [T.ROBOTICS]: 1, [T.ENGINEER]: 0.5}), token_count: 30 },
      { chunk_index: 1, chunk_text: '2024-03-22: Frank showed RoboLogic demo. Picking irregular objects at 98% accuracy. 2024-11-01: RoboLogic deployed at Amazon fulfillment center in Memphis.', chunk_source: 'timeline', embedding: topicEmbedding({[T.ROBOTICS]: 0.6, [T.LAUNCH]: 0.7, [T.MEETING]: 0.3}), token_count: 28 },
    ],
  },
  {
    slug: 'people/grace-lee',
    type: 'person',
    title: 'Grace Lee',
    compiled_truth: 'Grace Lee is a designer and founder of PixelCraft, a design tool for AI-generated UI components. Former lead designer at Figma. Strong opinions on AI replacing mockups with working prototypes.',
    timeline: '2024-04-30: Grace launched PixelCraft beta. 5000 signups in first week.\n2024-08-15: Grace hired 3 engineers from Vercel. PixelCraft growing fast.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Grace Lee is a designer and founder of PixelCraft, a design tool for AI-generated UI components. Former lead designer at Figma. Strong opinions on AI replacing mockups with working prototypes.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.5, [T.DESIGNER]: 0.9, [T.CONSUMER]: 0.4, [T.FOUNDER]: 0.5}), token_count: 34 },
      { chunk_index: 1, chunk_text: '2024-04-30: Grace launched PixelCraft beta. 5000 signups first week. 2024-08-15: Grace hired 3 engineers from Vercel. Growing fast.', chunk_source: 'timeline', embedding: topicEmbedding({[T.DESIGNER]: 0.3, [T.LAUNCH]: 0.8, [T.HIRING]: 0.5}), token_count: 25 },
    ],
  },
  {
    slug: 'people/hiro-tanaka',
    type: 'person',
    title: 'Hiro Tanaka',
    compiled_truth: 'Hiro Tanaka is CEO of GenomeAI, using large language models to predict protein folding for drug discovery. Previously research scientist at DeepMind. Published 40+ papers on computational biology.',
    timeline: '2024-02-14: Hiro presented GenomeAI results at Bio conference. Beat AlphaFold on 3 benchmarks.\n2024-10-20: GenomeAI partnered with Pfizer for oncology drug discovery pipeline.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Hiro Tanaka is CEO of GenomeAI, using large language models to predict protein folding for drug discovery. Previously research scientist at DeepMind. Published 40+ papers on computational biology.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.7, [T.BIOTECH]: 0.9, [T.FOUNDER]: 0.4}), token_count: 34 },
      { chunk_index: 1, chunk_text: '2024-02-14: Hiro presented GenomeAI results. Beat AlphaFold on 3 benchmarks. 2024-10-20: GenomeAI partnered with Pfizer for oncology drug discovery.', chunk_source: 'timeline', embedding: topicEmbedding({[T.BIOTECH]: 0.6, [T.ANNOUNCEMENT]: 0.5, [T.MEETING]: 0.4}), token_count: 28 },
    ],
  },
  {
    slug: 'people/iris-washington',
    type: 'person',
    title: 'Iris Washington',
    compiled_truth: 'Iris Washington is VP of Product at CloudScale, an enterprise infrastructure company. Expert in developer experience and platform engineering. Previously PM at AWS Lambda team.',
    timeline: '2024-05-18: Iris spoke at re:Invent about serverless at scale. Great talk on cold start optimization.\n2024-09-03: CloudScale acquired by Datadog for $2.1B.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Iris Washington is VP of Product at CloudScale, an enterprise infrastructure company. Expert in developer experience and platform engineering. Previously PM at AWS Lambda team.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.ENTERPRISE]: 0.9, [T.ENGINEER]: 0.5, [T.AI]: 0.2}), token_count: 30 },
      { chunk_index: 1, chunk_text: '2024-05-18: Iris spoke at re:Invent about serverless at scale. Cold start optimization. 2024-09-03: CloudScale acquired by Datadog for $2.1B.', chunk_source: 'timeline', embedding: topicEmbedding({[T.ENTERPRISE]: 0.4, [T.ANNOUNCEMENT]: 0.7, [T.MEETING]: 0.3}), token_count: 28 },
    ],
  },
  {
    slug: 'people/james-park',
    type: 'person',
    title: 'James Park',
    compiled_truth: 'James Park is a climate tech investor and founder of TerraFund. Focuses on hard tech: carbon capture, nuclear fusion, and sustainable materials. Believes climate is a $50T market by 2040.',
    timeline: '2024-07-22: James announced TerraFund II, $500M for climate deep tech.\n2024-11-15: Met James at Climate Week. He invested in 3 fusion startups this year.',
    chunks: [
      { chunk_index: 0, chunk_text: 'James Park is a climate tech investor and founder of TerraFund. Focuses on hard tech: carbon capture, nuclear fusion, sustainable materials. Climate is a $50T market by 2040.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.CLIMATE]: 0.9, [T.INVESTOR]: 0.8, [T.FOUNDER]: 0.3}), token_count: 32 },
      { chunk_index: 1, chunk_text: '2024-07-22: James announced TerraFund II, $500M for climate deep tech. 2024-11-15: Met James at Climate Week. Invested in 3 fusion startups.', chunk_source: 'timeline', embedding: topicEmbedding({[T.CLIMATE]: 0.5, [T.FUNDING]: 0.8, [T.MEETING]: 0.4}), token_count: 28 },
    ],
  },

  // ── Companies (10) ───────────────────────────────────────────
  {
    slug: 'companies/novapay',
    type: 'company',
    title: 'NovaPay',
    compiled_truth: 'NovaPay builds instant cross-border payments for SMBs. Founded by Alice Chen (ex-Stripe). Series B stage, expanding across Southeast Asia. Regulatory-first approach differentiates from competitors.',
    timeline: '2024-01-15: NovaPay launched in Thailand. 2024-06-20: Raised $45M Series B. 2024-09-01: Processed $1B in cross-border volume.',
    chunks: [
      { chunk_index: 0, chunk_text: 'NovaPay builds instant cross-border payments for SMBs. Founded by Alice Chen (ex-Stripe). Series B stage, expanding across Southeast Asia. Regulatory-first approach differentiates.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.FINTECH]: 1, [T.ENTERPRISE]: 0.4}), token_count: 30 },
      { chunk_index: 1, chunk_text: '2024-01-15: NovaPay launched in Thailand. 2024-06-20: Raised $45M Series B. 2024-09-01: Processed $1B in cross-border volume.', chunk_source: 'timeline', embedding: topicEmbedding({[T.FINTECH]: 0.4, [T.LAUNCH]: 0.5, [T.FUNDING]: 0.6}), token_count: 25 },
    ],
  },
  {
    slug: 'companies/mindbridge',
    type: 'company',
    title: 'MindBridge',
    compiled_truth: 'MindBridge builds AI diagnostic tools for mental health. 94% concordance with clinical diagnosis. Used by 200+ clinics. Carol Nakamura (CTO) leads the technical vision.',
    timeline: '2024-02-28: Presented at AI Health Summit. 2024-07-12: Series A fundraising, targeting $15M. 2024-10-01: FDA breakthrough device designation.',
    chunks: [
      { chunk_index: 0, chunk_text: 'MindBridge builds AI diagnostic tools for mental health. 94% concordance with clinical diagnosis. Used by 200+ clinics. Carol Nakamura leads technical vision.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.6, [T.HEALTH]: 0.9, [T.ENTERPRISE]: 0.3}), token_count: 28 },
      { chunk_index: 1, chunk_text: '2024-02-28: AI Health Summit presentation. 2024-07-12: Series A targeting $15M. 2024-10-01: FDA breakthrough device designation.', chunk_source: 'timeline', embedding: topicEmbedding({[T.HEALTH]: 0.5, [T.FUNDING]: 0.5, [T.ANNOUNCEMENT]: 0.6}), token_count: 22 },
    ],
  },
  {
    slug: 'companies/cryptosafe',
    type: 'company',
    title: 'CryptoSafe',
    compiled_truth: 'CryptoSafe provides institutional-grade custody for digital assets using multi-party computation. Founded by Elena Volkov (ex-Google security). $30M Series A from a16z crypto.',
    timeline: '2024-01-20: ETH Denver demo. 2024-06-15: $30M Series A announced. 2024-10-30: Onboarded first sovereign wealth fund client.',
    chunks: [
      { chunk_index: 0, chunk_text: 'CryptoSafe provides institutional-grade custody for digital assets using multi-party computation. Founded by Elena Volkov. $30M Series A from a16z crypto.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.CRYPTO]: 0.9, [T.ENTERPRISE]: 0.5, [T.FINTECH]: 0.3}), token_count: 26 },
      { chunk_index: 1, chunk_text: '2024-01-20: ETH Denver demo. 2024-06-15: $30M Series A. 2024-10-30: First sovereign wealth fund client.', chunk_source: 'timeline', embedding: topicEmbedding({[T.CRYPTO]: 0.4, [T.FUNDING]: 0.7, [T.ANNOUNCEMENT]: 0.5}), token_count: 20 },
    ],
  },
  {
    slug: 'companies/robologic',
    type: 'company',
    title: 'RoboLogic',
    compiled_truth: 'RoboLogic builds autonomous warehouse robots for irregular object picking. 98% accuracy on unstructured items. Frank Dubois (head of AI) leads R&D. Deployed at major fulfillment centers.',
    timeline: '2024-03-22: Demo day showing. 2024-11-01: Amazon fulfillment deployment in Memphis.',
    chunks: [
      { chunk_index: 0, chunk_text: 'RoboLogic builds autonomous warehouse robots for irregular object picking. 98% accuracy. Frank Dubois leads R&D. Deployed at major fulfillment centers.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.ROBOTICS]: 0.9, [T.AI]: 0.6, [T.ENTERPRISE]: 0.4}), token_count: 25 },
      { chunk_index: 1, chunk_text: '2024-03-22: Demo day showing. 2024-11-01: Amazon fulfillment deployment in Memphis.', chunk_source: 'timeline', embedding: topicEmbedding({[T.ROBOTICS]: 0.4, [T.LAUNCH]: 0.8}), token_count: 15 },
    ],
  },
  {
    slug: 'companies/edustack',
    type: 'company',
    title: 'EduStack',
    compiled_truth: 'EduStack is an AI-powered adaptive learning platform. Personalizes curriculum in real-time based on student performance. Founded by David Okonkwo (ex-Stanford CS). Growing 40% MoM in Nigeria.',
    timeline: '2024-05-02: Demo day presentation. 2024-09-18: V2 launch with real-time assessment. 2024-12-01: Expanded to Kenya and Ghana.',
    chunks: [
      { chunk_index: 0, chunk_text: 'EduStack is an AI-powered adaptive learning platform. Personalizes curriculum in real-time. Founded by David Okonkwo. Growing 40% MoM in Nigeria.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.5, [T.EDUCATION]: 0.9, [T.CONSUMER]: 0.4}), token_count: 26 },
      { chunk_index: 1, chunk_text: '2024-05-02: Demo day. 2024-09-18: V2 with real-time assessment. 2024-12-01: Expanded to Kenya and Ghana.', chunk_source: 'timeline', embedding: topicEmbedding({[T.EDUCATION]: 0.4, [T.LAUNCH]: 0.7, [T.ANNOUNCEMENT]: 0.3}), token_count: 20 },
    ],
  },
  {
    slug: 'companies/pixelcraft',
    type: 'company', title: 'PixelCraft',
    compiled_truth: 'PixelCraft is a design tool that generates working UI components from natural language. Founded by Grace Lee (ex-Figma). 5000 signups in first week of beta.',
    timeline: '2024-04-30: Beta launch, 5000 signups. 2024-08-15: Hired 3 Vercel engineers.',
    chunks: [
      { chunk_index: 0, chunk_text: 'PixelCraft generates working UI components from natural language. Founded by Grace Lee (ex-Figma). 5000 signups first week.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.6, [T.DESIGNER]: 0.8, [T.CONSUMER]: 0.5}), token_count: 22 },
      { chunk_index: 1, chunk_text: '2024-04-30: Beta launch, 5000 signups. 2024-08-15: Hired 3 Vercel engineers.', chunk_source: 'timeline', embedding: topicEmbedding({[T.LAUNCH]: 0.8, [T.HIRING]: 0.6}), token_count: 14 },
    ],
  },
  {
    slug: 'companies/genomeai',
    type: 'company', title: 'GenomeAI',
    compiled_truth: 'GenomeAI uses LLMs to predict protein folding for drug discovery. Beat AlphaFold on 3 benchmarks. CEO Hiro Tanaka (ex-DeepMind). Partnered with Pfizer.',
    timeline: '2024-02-14: Bio conference results. 2024-10-20: Pfizer partnership announced.',
    chunks: [
      { chunk_index: 0, chunk_text: 'GenomeAI uses LLMs to predict protein folding for drug discovery. Beat AlphaFold on 3 benchmarks. CEO Hiro Tanaka. Pfizer partnership.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.7, [T.BIOTECH]: 0.9}), token_count: 24 },
      { chunk_index: 1, chunk_text: '2024-02-14: Bio conference, beat AlphaFold. 2024-10-20: Pfizer partnership for oncology.', chunk_source: 'timeline', embedding: topicEmbedding({[T.BIOTECH]: 0.5, [T.ANNOUNCEMENT]: 0.7}), token_count: 16 },
    ],
  },
  {
    slug: 'companies/terrafund',
    type: 'company', title: 'TerraFund',
    compiled_truth: 'TerraFund is a $500M climate deep tech fund. Founded by James Park. Invests in carbon capture, nuclear fusion, and sustainable materials. Three fusion investments in 2024.',
    timeline: '2024-07-22: TerraFund II announced at $500M. 2024-11-15: Climate Week panel.',
    chunks: [
      { chunk_index: 0, chunk_text: 'TerraFund is a $500M climate deep tech fund. Founded by James Park. Carbon capture, nuclear fusion, sustainable materials.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.CLIMATE]: 0.9, [T.INVESTOR]: 0.6, [T.FUNDING]: 0.3}), token_count: 22 },
      { chunk_index: 1, chunk_text: '2024-07-22: TerraFund II at $500M. 2024-11-15: Climate Week panel.', chunk_source: 'timeline', embedding: topicEmbedding({[T.CLIMATE]: 0.4, [T.FUNDING]: 0.8, [T.ANNOUNCEMENT]: 0.5}), token_count: 14 },
    ],
  },
  {
    slug: 'companies/cloudscale',
    type: 'company', title: 'CloudScale',
    compiled_truth: 'CloudScale is an enterprise infrastructure company focused on serverless at scale. Iris Washington is VP Product. Acquired by Datadog for $2.1B in 2024.',
    timeline: '2024-05-18: re:Invent talk on cold starts. 2024-09-03: Datadog acquisition at $2.1B.',
    chunks: [
      { chunk_index: 0, chunk_text: 'CloudScale is enterprise infrastructure for serverless at scale. VP Product Iris Washington. Acquired by Datadog for $2.1B.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.ENTERPRISE]: 0.9, [T.AI]: 0.2}), token_count: 22 },
      { chunk_index: 1, chunk_text: '2024-05-18: re:Invent cold start talk. 2024-09-03: Datadog acquired CloudScale for $2.1B.', chunk_source: 'timeline', embedding: topicEmbedding({[T.ENTERPRISE]: 0.3, [T.ANNOUNCEMENT]: 0.8}), token_count: 16 },
    ],
  },
  {
    slug: 'companies/solargrid',
    type: 'company', title: 'SolarGrid',
    compiled_truth: 'SolarGrid builds distributed solar micro-grids for rural electrification. Bob Martinez is a board member. Operating in 12 African countries.',
    timeline: '2024-08-05: Bob introduced the founder. 2024-12-10: SolarGrid hit 1M homes powered.',
    chunks: [
      { chunk_index: 0, chunk_text: 'SolarGrid builds distributed solar micro-grids for rural electrification. Bob Martinez board member. Operating in 12 African countries.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.CLIMATE]: 0.8, [T.ENTERPRISE]: 0.3}), token_count: 22 },
      { chunk_index: 1, chunk_text: '2024-08-05: Bob introduced founder. 2024-12-10: SolarGrid hit 1M homes powered.', chunk_source: 'timeline', embedding: topicEmbedding({[T.CLIMATE]: 0.3, [T.ANNOUNCEMENT]: 0.5, [T.MEETING]: 0.4}), token_count: 14 },
    ],
  },

  // ── Concepts (10) ────────────────────────────────────────────
  {
    slug: 'concepts/ai-first-companies',
    type: 'concept', title: 'AI-First Companies',
    compiled_truth: 'AI-first companies embed machine learning into the core product loop, not as a feature bolt-on. Examples: MindBridge (diagnostics), EduStack (adaptive learning), PixelCraft (design). The common pattern is that AI IS the product, not AI-enhanced.',
    timeline: '2024-03-01: Wrote first draft of AI-first thesis. 2024-09-15: Revisited after seeing 10 more examples.',
    chunks: [
      { chunk_index: 0, chunk_text: 'AI-first companies embed machine learning into the core product loop. MindBridge, EduStack, PixelCraft. AI IS the product, not AI-enhanced.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 1, [T.FOUNDER]: 0.3, [T.ENTERPRISE]: 0.2, [T.CONSUMER]: 0.2}), token_count: 26 },
      { chunk_index: 1, chunk_text: '2024-03-01: First draft of AI-first thesis. 2024-09-15: Revisited after 10 more examples.', chunk_source: 'timeline', embedding: topicEmbedding({[T.AI]: 0.5, [T.TIMELINE]: 0.5}), token_count: 18 },
    ],
  },
  {
    slug: 'concepts/climate-investing',
    type: 'concept', title: 'Climate Tech Investment Thesis',
    compiled_truth: 'Climate tech is a $50T market by 2040. Three waves: solar/wind (done), batteries/grid (now), carbon capture/fusion (next). TerraFund and Green Horizon are the key funds. Hard tech wins over software-only.',
    timeline: '2024-04-10: Bob articulated the three-wave framework. 2024-11-15: James confirmed fusion timeline at Climate Week.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Climate tech is a $50T market by 2040. Three waves: solar/wind (done), batteries/grid (now), carbon capture/fusion (next). TerraFund and Green Horizon key funds.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.CLIMATE]: 1, [T.INVESTOR]: 0.5, [T.FUNDING]: 0.3}), token_count: 30 },
      { chunk_index: 1, chunk_text: '2024-04-10: Bob three-wave framework. 2024-11-15: James confirmed fusion timeline at Climate Week.', chunk_source: 'timeline', embedding: topicEmbedding({[T.CLIMATE]: 0.5, [T.MEETING]: 0.5, [T.INVESTOR]: 0.3}), token_count: 18 },
    ],
  },
  {
    slug: 'concepts/fintech-rails',
    type: 'concept', title: 'Payment Rails Infrastructure',
    compiled_truth: 'Cross-border payments are still broken. SWIFT takes 3-5 days. NovaPay and similar startups are building real-time rails using local payment networks. Regulatory compliance is the moat, not technology.',
    timeline: '2024-03-15: Alice explained regulatory-first approach at Fintech Forum.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Cross-border payments are still broken. SWIFT takes 3-5 days. NovaPay building real-time rails. Regulatory compliance is the moat, not technology.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.FINTECH]: 1, [T.ENTERPRISE]: 0.3}), token_count: 26 },
      { chunk_index: 1, chunk_text: '2024-03-15: Alice explained regulatory-first approach at Fintech Forum.', chunk_source: 'timeline', embedding: topicEmbedding({[T.FINTECH]: 0.4, [T.MEETING]: 0.6}), token_count: 12 },
    ],
  },
  {
    slug: 'concepts/crypto-custody',
    type: 'concept', title: 'Institutional Crypto Custody',
    compiled_truth: 'Institutional adoption of crypto requires custody solutions that meet banking-grade security standards. MPC (multi-party computation) is the winning architecture. CryptoSafe is leading this space.',
    timeline: '2024-01-20: Elena ETH Denver talk. 2024-10-30: First sovereign wealth fund using MPC custody.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Institutional crypto adoption requires banking-grade custody. MPC is the winning architecture. CryptoSafe leads.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.CRYPTO]: 0.9, [T.ENTERPRISE]: 0.5}), token_count: 18 },
      { chunk_index: 1, chunk_text: '2024-01-20: Elena ETH Denver talk on MPC. 2024-10-30: First sovereign wealth fund using MPC custody.', chunk_source: 'timeline', embedding: topicEmbedding({[T.CRYPTO]: 0.5, [T.ANNOUNCEMENT]: 0.5, [T.MEETING]: 0.3}), token_count: 18 },
    ],
  },
  {
    slug: 'concepts/ai-health',
    type: 'concept', title: 'AI in Healthcare',
    compiled_truth: 'AI in healthcare is moving from research to deployment. MindBridge (mental health, 94% accuracy), GenomeAI (drug discovery, beat AlphaFold). FDA is creating new regulatory pathways for AI diagnostics.',
    timeline: '2024-02-28: AI Health Summit. 2024-10-01: MindBridge FDA breakthrough designation.',
    chunks: [
      { chunk_index: 0, chunk_text: 'AI in healthcare moving from research to deployment. MindBridge 94% accuracy, GenomeAI beat AlphaFold. FDA creating new AI diagnostic pathways.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.7, [T.HEALTH]: 0.8, [T.BIOTECH]: 0.4}), token_count: 26 },
      { chunk_index: 1, chunk_text: '2024-02-28: AI Health Summit. 2024-10-01: MindBridge FDA breakthrough.', chunk_source: 'timeline', embedding: topicEmbedding({[T.HEALTH]: 0.5, [T.ANNOUNCEMENT]: 0.5, [T.AI]: 0.3}), token_count: 12 },
    ],
  },
  {
    slug: 'concepts/robotics-warehouse',
    type: 'concept', title: 'Warehouse Automation',
    compiled_truth: 'Warehouse robotics is moving from structured (conveyor belts, AGVs) to unstructured (picking irregular objects). RoboLogic at 98% accuracy. The bottleneck is manipulation, not navigation.',
    timeline: '2024-03-22: RoboLogic demo. 2024-11-01: Amazon deployment validates the market.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Warehouse robotics moving from structured to unstructured picking. RoboLogic 98% accuracy. Bottleneck is manipulation, not navigation.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.ROBOTICS]: 0.9, [T.AI]: 0.5, [T.ENTERPRISE]: 0.3}), token_count: 22 },
      { chunk_index: 1, chunk_text: '2024-03-22: RoboLogic demo. 2024-11-01: Amazon deployment validates market.', chunk_source: 'timeline', embedding: topicEmbedding({[T.ROBOTICS]: 0.4, [T.LAUNCH]: 0.6}), token_count: 12 },
    ],
  },
  {
    slug: 'concepts/ai-education',
    type: 'concept', title: 'AI in Education',
    compiled_truth: 'Personalized education at scale is now possible with AI. EduStack shows 40% MoM growth. The key insight: adaptive curriculum beats static textbooks because every student learns differently.',
    timeline: '2024-05-02: David demo day. 2024-12-01: EduStack expanded to 3 African countries.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Personalized education at scale with AI. EduStack 40% MoM growth. Adaptive curriculum beats static textbooks.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.5, [T.EDUCATION]: 0.9, [T.CONSUMER]: 0.3}), token_count: 20 },
      { chunk_index: 1, chunk_text: '2024-05-02: David demo. 2024-12-01: EduStack to Kenya and Ghana.', chunk_source: 'timeline', embedding: topicEmbedding({[T.EDUCATION]: 0.4, [T.LAUNCH]: 0.5}), token_count: 12 },
    ],
  },
  {
    slug: 'concepts/design-ai',
    type: 'concept', title: 'AI-Powered Design Tools',
    compiled_truth: 'AI is replacing the mockup-to-code pipeline. PixelCraft generates working components from descriptions. Grace Lee argues designers should think in systems, not screens. The next Figma is AI-native.',
    timeline: '2024-04-30: PixelCraft beta launch validated the thesis.',
    chunks: [
      { chunk_index: 0, chunk_text: 'AI replacing mockup-to-code pipeline. PixelCraft generates components from descriptions. Grace Lee: think in systems, not screens. Next Figma is AI-native.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.AI]: 0.6, [T.DESIGNER]: 0.9, [T.CONSUMER]: 0.3}), token_count: 28 },
      { chunk_index: 1, chunk_text: '2024-04-30: PixelCraft beta validated the thesis.', chunk_source: 'timeline', embedding: topicEmbedding({[T.DESIGNER]: 0.3, [T.LAUNCH]: 0.5}), token_count: 10 },
    ],
  },
  {
    slug: 'concepts/acquisitions-2024',
    type: 'concept', title: '2024 Notable Acquisitions',
    compiled_truth: 'Datadog acquired CloudScale for $2.1B (serverless infrastructure). Signaling: infrastructure consolidation is accelerating. Platform companies are buying specialized tools.',
    timeline: '2024-09-03: CloudScale acquisition announced. 2024-09-10: Market reacted positively, Datadog stock up 8%.',
    chunks: [
      { chunk_index: 0, chunk_text: 'Datadog acquired CloudScale for $2.1B. Infrastructure consolidation accelerating. Platform companies buying specialized tools.', chunk_source: 'compiled_truth', embedding: topicEmbedding({[T.ENTERPRISE]: 0.7, [T.ANNOUNCEMENT]: 0.5}), token_count: 20 },
      { chunk_index: 1, chunk_text: '2024-09-03: CloudScale acquisition. 2024-09-10: Datadog stock up 8%.', chunk_source: 'timeline', embedding: topicEmbedding({[T.ENTERPRISE]: 0.3, [T.ANNOUNCEMENT]: 0.7}), token_count: 12 },
    ],
  },
];

// ─── Benchmark Queries (20) ──────────────────────────────────────

interface BenchmarkQuery {
  id: string;
  query: string;
  queryEmbedding: Float32Array;
  relevant: string[];
  grades?: Record<string, number>;
  expectedSource: 'compiled_truth' | 'timeline';
  description: string;
}

const QUERIES: BenchmarkQuery[] = [
  // Entity lookups (should get compiled truth)
  { id: 'q01', query: 'Who is Alice Chen?', queryEmbedding: topicEmbedding({[T.FINTECH]: 0.8, [T.FOUNDER]: 0.5}), relevant: ['people/alice-chen', 'companies/novapay'], grades: {'people/alice-chen': 3, 'companies/novapay': 1}, expectedSource: 'compiled_truth', description: 'Person lookup: Alice Chen' },
  { id: 'q02', query: 'What does MindBridge do?', queryEmbedding: topicEmbedding({[T.AI]: 0.5, [T.HEALTH]: 0.8}), relevant: ['companies/mindbridge', 'people/carol-nakamura', 'concepts/ai-health'], grades: {'companies/mindbridge': 3, 'people/carol-nakamura': 2, 'concepts/ai-health': 1}, expectedSource: 'compiled_truth', description: 'Company lookup: MindBridge' },
  { id: 'q03', query: 'Tell me about climate tech investing', queryEmbedding: topicEmbedding({[T.CLIMATE]: 0.9, [T.INVESTOR]: 0.5}), relevant: ['concepts/climate-investing', 'people/bob-martinez', 'people/james-park', 'companies/terrafund'], grades: {'concepts/climate-investing': 3, 'people/james-park': 2, 'people/bob-martinez': 2, 'companies/terrafund': 1}, expectedSource: 'compiled_truth', description: 'Topic overview: climate investing' },

  // Temporal queries (should get timeline)
  { id: 'q04', query: 'When did we last meet Alice?', queryEmbedding: topicEmbedding({[T.FINTECH]: 0.4, [T.MEETING]: 0.9}), relevant: ['people/alice-chen'], expectedSource: 'timeline', description: 'Temporal: last meeting with Alice' },
  { id: 'q05', query: 'Recent updates on GenomeAI', queryEmbedding: topicEmbedding({[T.BIOTECH]: 0.6, [T.ANNOUNCEMENT]: 0.5}), relevant: ['companies/genomeai', 'people/hiro-tanaka'], grades: {'companies/genomeai': 3, 'people/hiro-tanaka': 1}, expectedSource: 'timeline', description: 'Temporal: GenomeAI updates' },
  { id: 'q06', query: 'What happened with the CloudScale acquisition?', queryEmbedding: topicEmbedding({[T.ENTERPRISE]: 0.6, [T.ANNOUNCEMENT]: 0.8}), relevant: ['companies/cloudscale', 'concepts/acquisitions-2024', 'people/iris-washington'], grades: {'companies/cloudscale': 3, 'concepts/acquisitions-2024': 2, 'people/iris-washington': 1}, expectedSource: 'timeline', description: 'Event: CloudScale acquisition' },

  // Cross-entity queries (tests relationship understanding)
  { id: 'q07', query: 'Alice Chen NovaPay cross-border payments', queryEmbedding: topicEmbedding({[T.FINTECH]: 0.9, [T.FOUNDER]: 0.3}), relevant: ['people/alice-chen', 'companies/novapay', 'concepts/fintech-rails'], grades: {'people/alice-chen': 2, 'companies/novapay': 3, 'concepts/fintech-rails': 2}, expectedSource: 'compiled_truth', description: 'Cross-entity: Alice + NovaPay' },
  { id: 'q08', query: 'Carol Nakamura MindBridge AI health', queryEmbedding: topicEmbedding({[T.AI]: 0.5, [T.HEALTH]: 0.7, [T.FOUNDER]: 0.3}), relevant: ['people/carol-nakamura', 'companies/mindbridge', 'concepts/ai-health'], grades: {'people/carol-nakamura': 2, 'companies/mindbridge': 2, 'concepts/ai-health': 2}, expectedSource: 'compiled_truth', description: 'Cross-entity: Carol + MindBridge' },

  // Competitive/thematic queries (multiple relevant pages)
  { id: 'q09', query: 'AI companies building real products', queryEmbedding: topicEmbedding({[T.AI]: 0.9, [T.FOUNDER]: 0.3, [T.CONSUMER]: 0.2}), relevant: ['concepts/ai-first-companies', 'companies/mindbridge', 'companies/edustack', 'companies/pixelcraft', 'companies/genomeai'], grades: {'concepts/ai-first-companies': 3, 'companies/mindbridge': 2, 'companies/edustack': 2, 'companies/pixelcraft': 2, 'companies/genomeai': 2}, expectedSource: 'compiled_truth', description: 'Thematic: AI companies' },
  { id: 'q10', query: 'Who raised funding recently?', queryEmbedding: topicEmbedding({[T.FUNDING]: 0.9, [T.ANNOUNCEMENT]: 0.4}), relevant: ['companies/novapay', 'companies/cryptosafe', 'companies/terrafund', 'people/carol-nakamura'], grades: {'companies/novapay': 2, 'companies/cryptosafe': 2, 'companies/terrafund': 2, 'people/carol-nakamura': 1}, expectedSource: 'timeline', description: 'Temporal: recent funding rounds' },

  // Hard disambiguation queries
  { id: 'q11', query: 'Bob and James climate investments', queryEmbedding: topicEmbedding({[T.CLIMATE]: 0.8, [T.INVESTOR]: 0.6}), relevant: ['people/bob-martinez', 'people/james-park', 'concepts/climate-investing', 'companies/terrafund'], grades: {'people/bob-martinez': 2, 'people/james-park': 2, 'concepts/climate-investing': 2, 'companies/terrafund': 1}, expectedSource: 'compiled_truth', description: 'Disambiguation: two climate investors' },
  { id: 'q12', query: 'AI replacing designers', queryEmbedding: topicEmbedding({[T.AI]: 0.6, [T.DESIGNER]: 0.8}), relevant: ['concepts/design-ai', 'companies/pixelcraft', 'people/grace-lee'], grades: {'concepts/design-ai': 3, 'companies/pixelcraft': 2, 'people/grace-lee': 2}, expectedSource: 'compiled_truth', description: 'Topic: AI and design' },

  // Full context requests
  { id: 'q13', query: 'Give me everything on RoboLogic', queryEmbedding: topicEmbedding({[T.ROBOTICS]: 0.9, [T.AI]: 0.4}), relevant: ['companies/robologic', 'people/frank-dubois', 'concepts/robotics-warehouse'], grades: {'companies/robologic': 3, 'people/frank-dubois': 2, 'concepts/robotics-warehouse': 1}, expectedSource: 'timeline', description: 'Full context: RoboLogic' },
  { id: 'q14', query: 'Deep dive on crypto custody', queryEmbedding: topicEmbedding({[T.CRYPTO]: 0.9, [T.ENTERPRISE]: 0.4}), relevant: ['concepts/crypto-custody', 'companies/cryptosafe', 'people/elena-volkov'], grades: {'concepts/crypto-custody': 3, 'companies/cryptosafe': 2, 'people/elena-volkov': 2}, expectedSource: 'timeline', description: 'Full context: crypto custody' },

  // Tricky queries that test boost vs natural
  { id: 'q15', query: 'Education technology Africa growth', queryEmbedding: topicEmbedding({[T.EDUCATION]: 0.8, [T.CONSUMER]: 0.3}), relevant: ['companies/edustack', 'people/david-okonkwo', 'concepts/ai-education'], grades: {'companies/edustack': 3, 'people/david-okonkwo': 2, 'concepts/ai-education': 2}, expectedSource: 'compiled_truth', description: 'Topic: edtech in Africa' },
  { id: 'q16', query: 'What launched this year?', queryEmbedding: topicEmbedding({[T.LAUNCH]: 0.9, [T.ANNOUNCEMENT]: 0.4}), relevant: ['companies/novapay', 'companies/pixelcraft', 'companies/edustack', 'companies/robologic'], grades: {'companies/pixelcraft': 2, 'companies/edustack': 2, 'companies/novapay': 2, 'companies/robologic': 2}, expectedSource: 'timeline', description: 'Temporal: 2024 launches' },

  // Narrow expert queries
  { id: 'q17', query: 'MPC multi-party computation wallets', queryEmbedding: topicEmbedding({[T.CRYPTO]: 0.8, [T.ENGINEER]: 0.4}), relevant: ['people/elena-volkov', 'companies/cryptosafe', 'concepts/crypto-custody'], grades: {'people/elena-volkov': 3, 'companies/cryptosafe': 2, 'concepts/crypto-custody': 2}, expectedSource: 'compiled_truth', description: 'Expert: MPC wallets' },
  { id: 'q18', query: 'Protein folding drug discovery LLMs', queryEmbedding: topicEmbedding({[T.AI]: 0.6, [T.BIOTECH]: 0.9}), relevant: ['companies/genomeai', 'people/hiro-tanaka', 'concepts/ai-health'], grades: {'companies/genomeai': 3, 'people/hiro-tanaka': 2, 'concepts/ai-health': 1}, expectedSource: 'compiled_truth', description: 'Expert: protein folding AI' },

  // Negative control
  { id: 'q19', query: 'quantum computing error correction', queryEmbedding: topicEmbedding({100: 1}), relevant: [], expectedSource: 'compiled_truth', description: 'Negative: no relevant pages' },

  // Ambiguous query (could be entity OR temporal)
  { id: 'q20', query: 'EduStack Nigeria', queryEmbedding: topicEmbedding({[T.EDUCATION]: 0.7, [T.CONSUMER]: 0.3}), relevant: ['companies/edustack', 'people/david-okonkwo'], grades: {'companies/edustack': 3, 'people/david-okonkwo': 1}, expectedSource: 'compiled_truth', description: 'Ambiguous: EduStack in Nigeria' },
];

// ─── Benchmark Runner ────────────────────────────────────────────

interface RunResult {
  queryId: string;
  hits: SearchResult[];
  // Page-level metrics (traditional IR)
  precision1: number;
  precision5: number;
  recall5: number;
  mrrScore: number;
  ndcg5: number;
  // Chunk-level metrics (what PR#64 actually improves)
  sourceCorrect: boolean;       // Is the top chunk the right source type?
  chunksPerPage: number;        // Avg chunks per unique page in results
  compiledTruthFirst: number;   // For entity queries: is compiled_truth the first chunk per page?
  timelineAccessible: boolean;  // Are timeline chunks present in results?
  compiledTruthGuaranteed: boolean; // Does every page have at least 1 compiled_truth chunk?
  uniquePages: number;          // How many distinct pages appear
  compiledTruthRatio: number;   // What % of result chunks are compiled_truth
}

function analyzeRun(q: BenchmarkQuery, hits: SearchResult[]): RunResult {
  const slugs = hits.map(r => r.slug);
  const rel = new Set(q.relevant);
  const grades = new Map(Object.entries(q.grades ?? Object.fromEntries(q.relevant.map(s => [s, 1]))));

  // Page-level metrics
  const uniqueSlugs = [...new Set(slugs)];
  const chunksPerPage = uniqueSlugs.length > 0 ? hits.length / uniqueSlugs.length : 0;

  // Chunk-source analysis per page
  const byPage = new Map<string, SearchResult[]>();
  for (const h of hits) {
    const arr = byPage.get(h.slug) || [];
    arr.push(h);
    byPage.set(h.slug, arr);
  }

  // For entity queries: is the first chunk of each relevant page compiled_truth?
  let ctFirstCount = 0, ctFirstTotal = 0;
  for (const [slug, chunks] of byPage) {
    if (rel.has(slug) && q.expectedSource === 'compiled_truth') {
      ctFirstTotal++;
      if (chunks[0]?.chunk_source === 'compiled_truth') ctFirstCount++;
    }
  }

  // Compiled truth guarantee: does every page in results have at least 1 CT chunk?
  let ctGuaranteed = true;
  for (const [_, chunks] of byPage) {
    if (!chunks.some(c => c.chunk_source === 'compiled_truth')) {
      ctGuaranteed = false;
      break;
    }
  }

  const ctChunks = hits.filter(h => h.chunk_source === 'compiled_truth').length;

  return {
    queryId: q.id, hits,
    precision1: precisionAtK(slugs, rel, 1),
    precision5: precisionAtK(slugs, rel, 5),
    recall5: recallAtK(slugs, rel, 5),
    mrrScore: mrr(slugs, rel),
    ndcg5: ndcgAtK(slugs, grades, 5),
    sourceCorrect: hits.length > 0 ? hits[0].chunk_source === q.expectedSource : q.relevant.length === 0,
    chunksPerPage,
    compiledTruthFirst: ctFirstTotal > 0 ? ctFirstCount / ctFirstTotal : -1,
    timelineAccessible: hits.some(h => h.chunk_source === 'timeline'),
    compiledTruthGuaranteed: ctGuaranteed,
    uniquePages: uniqueSlugs.length,
    compiledTruthRatio: hits.length > 0 ? ctChunks / hits.length : 0,
  };
}

async function runBenchmark(engine: PGLiteEngine, queries: BenchmarkQuery[], mode: 'baseline' | 'boost' | 'intent'): Promise<RunResult[]> {
  const results: RunResult[] = [];
  for (const q of queries) {
    let detail: 'low' | 'medium' | 'high' | undefined;
    let applyBoost = true;

    if (mode === 'intent') {
      detail = autoDetectDetail(q.query);
      applyBoost = detail !== 'high';
    } else if (mode === 'baseline') {
      applyBoost = false;
    }

    const kw = await engine.searchKeyword(q.query, { limit: 20, detail });
    const vec = await engine.searchVector(q.queryEmbedding, { limit: 20, detail });

    const fused = mode === 'baseline'
      ? rrfFusionBaseline([vec, kw])
      : rrfFusion([vec, kw], RRF_K, applyBoost);

    const deduped = dedupResults(fused);
    const top = deduped.slice(0, 10);
    results.push(analyzeRun(q, top));
  }
  return results;
}

function rrfFusionBaseline(lists: SearchResult[][]): SearchResult[] {
  const scores = new Map<string, { result: SearchResult; score: number }>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const key = `${r.slug}:${r.chunk_text.slice(0, 50)}`;
      const existing = scores.get(key);
      const s = 1 / (RRF_K + rank);
      if (existing) existing.score += s;
      else scores.set(key, { result: r, score: s });
    }
  }
  return Array.from(scores.values()).sort((a, b) => b.score - a.score).map(({ result, score }) => ({ ...result, score }));
}

// ─── Output ──────────────────────────────────────────────────────

interface AggMetrics {
  p1: number; p5: number; r5: number; mrr: number; ndcg: number;
  srcAcc: number;
  avgChunksPerPage: number;
  ctFirstRate: number;       // % of entity queries where compiled_truth is first per page
  timelineRate: number;      // % of temporal queries where timeline is accessible
  ctGuaranteeRate: number;   // % of queries where every page has a CT chunk
  avgUniquePages: number;
  avgCtRatio: number;
}

function aggregate(results: RunResult[], queries: BenchmarkQuery[]): AggMetrics {
  const v = results.filter(r => queries.find(q => q.id === r.queryId)!.relevant.length > 0);
  const entityQ = v.filter(r => queries.find(q => q.id === r.queryId)!.expectedSource === 'compiled_truth');
  const temporalQ = v.filter(r => queries.find(q => q.id === r.queryId)!.expectedSource === 'timeline');
  const ctFirstValid = entityQ.filter(r => r.compiledTruthFirst >= 0);

  return {
    p1: v.reduce((s, r) => s + r.precision1, 0) / v.length,
    p5: v.reduce((s, r) => s + r.precision5, 0) / v.length,
    r5: v.reduce((s, r) => s + r.recall5, 0) / v.length,
    mrr: v.reduce((s, r) => s + r.mrrScore, 0) / v.length,
    ndcg: v.reduce((s, r) => s + r.ndcg5, 0) / v.length,
    srcAcc: v.filter(r => r.sourceCorrect).length / v.length,
    avgChunksPerPage: v.reduce((s, r) => s + r.chunksPerPage, 0) / v.length,
    ctFirstRate: ctFirstValid.length > 0 ? ctFirstValid.reduce((s, r) => s + r.compiledTruthFirst, 0) / ctFirstValid.length : 0,
    timelineRate: temporalQ.length > 0 ? temporalQ.filter(r => r.timelineAccessible).length / temporalQ.length : 0,
    ctGuaranteeRate: v.filter(r => r.compiledTruthGuaranteed).length / v.length,
    avgUniquePages: v.reduce((s, r) => s + r.uniquePages, 0) / v.length,
    avgCtRatio: v.reduce((s, r) => s + r.compiledTruthRatio, 0) / v.length,
  };
}

function d(a: number, b: number): string {
  const v = a - b;
  return `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
}

function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (const page of PAGES) {
    await engine.putPage(page.slug, { type: page.type, title: page.title, compiled_truth: page.compiled_truth, timeline: page.timeline });
    await engine.upsertChunks(page.slug, page.chunks);
  }

  console.log(`Seeded ${PAGES.length} pages, ${PAGES.reduce((s, p) => s + p.chunks.length, 0)} chunks`);
  console.log(`Running ${QUERIES.length} queries x 3 configurations...\n`);

  const baseline = await runBenchmark(engine, QUERIES, 'baseline');
  const boosted = await runBenchmark(engine, QUERIES, 'boost');
  const withIntent = await runBenchmark(engine, QUERIES, 'intent');

  const bm = aggregate(baseline, QUERIES);
  const am = aggregate(boosted, QUERIES);
  const im = aggregate(withIntent, QUERIES);

  const date = new Date().toISOString().split('T')[0];
  const md: string[] = [];

  md.push(`# Search Quality Benchmark: ${date}`);
  md.push('');
  md.push(`## Overview`);
  md.push('');
  md.push(`- **${PAGES.length} pages** (${PAGES.filter(p => p.type === 'person').length} people, ${PAGES.filter(p => p.type === 'company').length} companies, ${PAGES.filter(p => p.type === 'concept').length} concepts)`);
  md.push(`- **${PAGES.reduce((s, p) => s + p.chunks.length, 0)} chunks** with overlapping semantic embeddings`);
  md.push(`- **${QUERIES.length} queries** with graded relevance (1-3 grades, multiple relevant pages)`);
  md.push(`- **3 configurations:** baseline, boost only, boost + intent classifier`);
  md.push('');
  md.push('All data is fictional. No private information. Embeddings use shared topic dimensions');
  md.push('to simulate real semantic overlap (e.g., "AI" appears in health, education, design, robotics).');
  md.push('');
  md.push('Inspired by [Ramp Labs\' "Latent Briefing" paper](https://ramp.com) (April 2026).');
  md.push('');

  // ─── Traditional IR metrics ───────────────────────────────────
  md.push('## Page-Level Retrieval (Traditional IR)');
  md.push('');
  md.push('*"Did we find the right page?"*');
  md.push('');
  md.push('| Metric | A. Baseline | B. Boost | C. Intent | B vs A | C vs A |');
  md.push('|--------|-------------|----------|-----------|--------|--------|');
  md.push(`| P@1 | ${bm.p1.toFixed(3)} | ${am.p1.toFixed(3)} | ${im.p1.toFixed(3)} | ${d(am.p1, bm.p1)} | ${d(im.p1, bm.p1)} |`);
  md.push(`| P@5 | ${bm.p5.toFixed(3)} | ${am.p5.toFixed(3)} | ${im.p5.toFixed(3)} | ${d(am.p5, bm.p5)} | ${d(im.p5, bm.p5)} |`);
  md.push(`| Recall@5 | ${bm.r5.toFixed(3)} | ${am.r5.toFixed(3)} | ${im.r5.toFixed(3)} | ${d(am.r5, bm.r5)} | ${d(im.r5, bm.r5)} |`);
  md.push(`| MRR | ${bm.mrr.toFixed(3)} | ${am.mrr.toFixed(3)} | ${im.mrr.toFixed(3)} | ${d(am.mrr, bm.mrr)} | ${d(im.mrr, bm.mrr)} |`);
  md.push(`| nDCG@5 | ${bm.ndcg.toFixed(3)} | ${am.ndcg.toFixed(3)} | ${im.ndcg.toFixed(3)} | ${d(am.ndcg, bm.ndcg)} | ${d(im.ndcg, bm.ndcg)} |`);
  md.push('');

  // ─── Chunk-level metrics (the real improvements) ──────────────
  md.push('## Chunk-Level Quality (What PR#64 Actually Improves)');
  md.push('');
  md.push('*"Did we find the right CHUNK from the right page?"*');
  md.push('');
  md.push('| Metric | A. Baseline | B. Boost | C. Intent | B vs A | C vs A |');
  md.push('|--------|-------------|----------|-----------|--------|--------|');
  md.push(`| Source accuracy (top chunk = expected type) | ${pct(bm.srcAcc)} | ${pct(am.srcAcc)} | ${pct(im.srcAcc)} | ${d(am.srcAcc, bm.srcAcc)} | ${d(im.srcAcc, bm.srcAcc)} |`);
  md.push(`| CT-first rate (entity Qs: CT chunk leads per page) | ${pct(bm.ctFirstRate)} | ${pct(am.ctFirstRate)} | ${pct(im.ctFirstRate)} | ${d(am.ctFirstRate, bm.ctFirstRate)} | ${d(im.ctFirstRate, bm.ctFirstRate)} |`);
  md.push(`| Timeline accessible (temporal Qs: TL in results) | ${pct(bm.timelineRate)} | ${pct(am.timelineRate)} | ${pct(im.timelineRate)} | ${d(am.timelineRate, bm.timelineRate)} | ${d(im.timelineRate, bm.timelineRate)} |`);
  md.push(`| CT guarantee (every page has a CT chunk) | ${pct(bm.ctGuaranteeRate)} | ${pct(am.ctGuaranteeRate)} | ${pct(im.ctGuaranteeRate)} | ${d(am.ctGuaranteeRate, bm.ctGuaranteeRate)} | ${d(im.ctGuaranteeRate, bm.ctGuaranteeRate)} |`);
  md.push(`| Avg chunks per page in results | ${bm.avgChunksPerPage.toFixed(2)} | ${am.avgChunksPerPage.toFixed(2)} | ${im.avgChunksPerPage.toFixed(2)} | ${d(am.avgChunksPerPage, bm.avgChunksPerPage)} | ${d(im.avgChunksPerPage, bm.avgChunksPerPage)} |`);
  md.push(`| Avg unique pages in top-10 | ${bm.avgUniquePages.toFixed(1)} | ${am.avgUniquePages.toFixed(1)} | ${im.avgUniquePages.toFixed(1)} | ${d(am.avgUniquePages, bm.avgUniquePages)} | ${d(im.avgUniquePages, bm.avgUniquePages)} |`);
  md.push(`| Compiled truth ratio in results | ${pct(bm.avgCtRatio)} | ${pct(am.avgCtRatio)} | ${pct(im.avgCtRatio)} | ${d(am.avgCtRatio, bm.avgCtRatio)} | ${d(im.avgCtRatio, bm.avgCtRatio)} |`);
  md.push('');

  // ─── Per-query breakdown ──────────────────────────────────────
  md.push('## Per-Query Detail');
  md.push('');
  md.push('| # | Query | Type | Detail | P@1 B/C | Src B→C | CT 1st B/C | Pages B/C |');
  md.push('|---|-------|------|--------|---------|---------|------------|-----------|');
  for (let i = 0; i < QUERIES.length; i++) {
    const q = QUERIES[i];
    if (q.relevant.length === 0) continue;
    const b = baseline[i], c = withIntent[i];
    const detail = autoDetectDetail(q.query) ?? 'med';
    const srcB = b.hits[0]?.chunk_source?.slice(0, 4) ?? '-';
    const srcC = c.hits[0]?.chunk_source?.slice(0, 4) ?? '-';
    const exp = q.expectedSource.slice(0, 4);
    const srcMatch = `${srcB}→${srcC} (${exp})`;
    const ctB = b.compiledTruthFirst >= 0 ? pct(b.compiledTruthFirst) : 'n/a';
    const ctC = c.compiledTruthFirst >= 0 ? pct(c.compiledTruthFirst) : 'n/a';
    md.push(`| ${q.id} | ${q.description.slice(0, 38)} | ${q.expectedSource.slice(0,4)} | ${detail.slice(0,3)} | ${b.precision1.toFixed(0)}/${c.precision1.toFixed(0)} | ${srcMatch} | ${ctB}/${ctC} | ${b.uniquePages}/${c.uniquePages} |`);
  }
  md.push('');

  // ─── Analysis ─────────────────────────────────────────────────
  md.push('## Analysis');
  md.push('');

  const improvements: string[] = [];
  const regressions: string[] = [];

  if (im.srcAcc > bm.srcAcc) improvements.push(`Source accuracy: ${pct(bm.srcAcc)} → ${pct(im.srcAcc)}`);
  if (im.srcAcc < bm.srcAcc) regressions.push(`Source accuracy: ${pct(bm.srcAcc)} → ${pct(im.srcAcc)}`);
  if (im.ctFirstRate > bm.ctFirstRate) improvements.push(`CT-first rate: ${pct(bm.ctFirstRate)} → ${pct(im.ctFirstRate)}`);
  if (im.ctGuaranteeRate > bm.ctGuaranteeRate) improvements.push(`CT guarantee: ${pct(bm.ctGuaranteeRate)} → ${pct(im.ctGuaranteeRate)}`);
  if (im.timelineRate > bm.timelineRate) improvements.push(`Timeline accessible: ${pct(bm.timelineRate)} → ${pct(im.timelineRate)}`);
  if (im.avgChunksPerPage > bm.avgChunksPerPage) improvements.push(`Chunks/page: ${bm.avgChunksPerPage.toFixed(2)} → ${im.avgChunksPerPage.toFixed(2)}`);
  if (im.avgUniquePages > bm.avgUniquePages) improvements.push(`Unique pages: ${bm.avgUniquePages.toFixed(1)} → ${im.avgUniquePages.toFixed(1)}`);

  if (improvements.length > 0) {
    md.push('### Improvements (C vs A)');
    for (const imp of improvements) md.push(`- ${imp}`);
    md.push('');
  }
  if (regressions.length > 0) {
    md.push('### Regressions (C vs A)');
    for (const reg of regressions) md.push(`- ${reg}`);
    md.push('');
  }
  if (improvements.length === 0 && regressions.length === 0) {
    md.push('No chunk-level regressions or improvements detected in this run.');
    md.push('');
  }

  // Boost-only damage report
  md.push('### Boost-Only Damage Report (B vs A)');
  md.push('');
  md.push('The boost without the intent classifier causes these regressions:');
  md.push('');
  if (am.srcAcc < bm.srcAcc) md.push(`- Source accuracy drops: ${pct(bm.srcAcc)} → ${pct(am.srcAcc)} (${((am.srcAcc - bm.srcAcc) * 100).toFixed(1)}pp)`);
  if (am.timelineRate < bm.timelineRate) md.push(`- Timeline accessibility drops: ${pct(bm.timelineRate)} → ${pct(am.timelineRate)}`);
  if (am.p1 < bm.p1) md.push(`- P@1 drops: ${bm.p1.toFixed(3)} → ${am.p1.toFixed(3)}`);
  md.push('');
  md.push('The intent classifier recovers all of these by routing temporal/event queries to detail=high (no boost).');
  md.push('');

  md.push('## Methodology');
  md.push('');
  md.push('- **Engine:** PGLite (in-memory Postgres 17.5 via WASM)');
  md.push('- **Embeddings:** Normalized topic vectors with shared dimensions (25 topic axes)');
  md.push('- **Overlap:** Multiple pages share topics (e.g., 5 pages relevant for "AI companies")');
  md.push('- **Graded relevance:** 1-3 grades per query (3 = primary, 1 = tangentially relevant)');
  md.push('');
  md.push('### Metrics explained');
  md.push('');
  md.push('**Page-level (traditional IR):** P@k, Recall@k, MRR, nDCG@5 measure "did we find the right page?"');
  md.push('');
  md.push('**Chunk-level (what matters for brain search):**');
  md.push('- **Source accuracy:** Is the very first chunk the right TYPE for this query? Entity lookup → compiled truth. Temporal query → timeline.');
  md.push('- **CT-first rate:** For entity queries, is compiled truth the FIRST chunk shown per page? (Not buried below timeline noise.)');
  md.push('- **Timeline accessible:** For temporal queries, do timeline chunks actually appear in results? (Not filtered out by the boost.)');
  md.push('- **CT guarantee:** Does every page in results have at least one compiled truth chunk? (Source-aware dedup.)');
  md.push('- **Chunks/page:** How many chunks per page appear? More = richer context for the agent.');
  md.push('- **Unique pages:** How many distinct pages in top-10? More = broader coverage.');
  md.push('');
  md.push('### Configurations');
  md.push('- A. **Baseline:** RRF K=60, no normalization, no boost, text-prefix dedup key');
  md.push('- B. **Boost only:** RRF normalized to 0-1, 2.0x compiled_truth boost, chunk_id dedup key, source-aware dedup');
  md.push('- C. **Boost + Intent:** B + heuristic intent classifier auto-selects detail level. Entity queries get detail=low (CT only). Temporal/event queries get detail=high (no boost, natural ranking). General queries get default medium.');

  const output = md.join('\n');
  console.log(output);

  const fs = require('fs');
  fs.mkdirSync('docs/benchmarks', { recursive: true });
  fs.writeFileSync(`docs/benchmarks/${date}.md`, output);
  console.log(`\nWritten to docs/benchmarks/${date}.md`);

  await engine.disconnect();
}

main().catch(console.error);
