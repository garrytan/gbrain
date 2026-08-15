import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync } from 'fs';
import { join, relative } from 'path';

const ENV_PATH = '/root/.hermes/.env';
let GOOGLE_API_KEY = '';

if (existsSync(ENV_PATH)) {
  const content = readFileSync(ENV_PATH, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const parts = trimmed.split('=');
      const key = parts[0].trim();
      const val = parts.slice(1).join('=').trim();
      if (key === 'GOOGLE_API_KEY') {
        GOOGLE_API_KEY = val;
        break;
      }
    }
  }
}

if (!GOOGLE_API_KEY) {
  console.error("Error: GOOGLE_API_KEY not found in /root/.hermes/.env");
  process.exit(1);
}

const args = process.argv.slice(2);
const command = args[0] || 'help';

const BRAIN_DIR = '/root/brain';

if (command === 'help') {
  console.log(`GBrain Booster - Lightweight AI Meta-Enricher
==============================================
Usage:
  bun run booster.js tags [--force]      Add AI tags to files lacking them
  bun run booster.js timeline [--force]  Extract timeline entries from files lacking them

Safeguards:
  - 100% Sequential execution (No CPU spikes, 0% local compute)
  - Throttled API requests (1 request per second to prevent API rate limiting)
  - Safe, non-destructive file updates (Only touches metadata & appends timeline)
`);
  process.exit(0);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'exports') continue;
    const full = join(dir, entry);
    try {
      if (lstatSync(full).isDirectory()) {
        walk(full, files);
      } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
        files.push(full);
      }
    } catch { /* skip unreadable */ }
  }
  return files;
}

async function callGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GOOGLE_API_KEY}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json"
        }
      })
    });
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error(`Invalid API response: ${JSON.stringify(data)}`);
    }
    return JSON.parse(text.trim());
  } catch (e) {
    console.error("Gemini API call failed:", e.message);
    return null;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTags(force = false) {
  console.log("Scanning files for auto-tagging...");
  const files = walk(BRAIN_DIR);
  console.log(`Found ${files.length} markdown files.`);

  let enrichedCount = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const rel = relative(BRAIN_DIR, file);

    const hasFrontmatter = content.startsWith('---');
    if (!hasFrontmatter) continue;

    const parts = content.split('---');
    if (parts.length < 3) continue;

    const frontmatter = parts[1];
    const hasTags = frontmatter.includes('tags:');

    if (hasTags && !force) {
      continue;
    }

    console.log(`\nEnriching tags for: ${rel}`);
    const body = parts.slice(2).join('---').slice(0, 5000); // Send first 5k characters

    const prompt = `Analyze this markdown note. Recommend 2 to 5 short semantic tags representing the categories or themes.
Return ONLY a JSON array of strings. No markdown, no wrap. Example: ["looksism", "sociology", "labor-market"].

Title: ${rel}
Content:
${body}`;

    const tags = await callGemini(prompt);
    if (tags && Array.isArray(tags)) {
      console.log(`  -> Recommended tags: ${JSON.stringify(tags)}`);

      let updatedFM = '';
      if (hasTags) {
        // Replace existing tags line
        const lines = frontmatter.split('\n');
        const index = lines.findIndex(l => l.trim().startsWith('tags:'));
        lines[index] = `tags: [${tags.map(t => `"${t}"`).join(', ')}]`;
        updatedFM = lines.join('\n');
      } else {
        // Append tags line before second ---
        updatedFM = frontmatter.trim() + `\ntags: [${tags.map(t => `"${t}"`).join(', ')}]\n`;
      }

      const updatedContent = `---${updatedFM}---` + parts.slice(2).join('---');
      writeFileSync(file, updatedContent, 'utf-8');
      console.log(`  -> Successfully updated tags in-place.`);
      enrichedCount++;
      await delay(1000); // 1s throttle safeguard
    }
  }

  console.log(`\nEnriched ${enrichedCount} files with semantic tags.`);
}

async function runTimeline(force = false) {
  console.log("Scanning files for timeline extraction...");
  const files = walk(BRAIN_DIR);
  console.log(`Found ${files.length} markdown files.`);

  let enrichedCount = 0;

  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const rel = relative(BRAIN_DIR, file);

    const hasTimeline = content.includes('## Timeline');
    if (hasTimeline && !force) {
      continue;
    }

    // Skip short or system files
    if (content.length < 500) continue;

    console.log(`\nExtracting timeline for: ${rel}`);
    const body = content.slice(0, 8000); // Send first 8k chars

    const prompt = `Analyze this markdown note. Extract any specific historical date, year, or events mentioned in format "YYYY-MM-DD" or "YYYY-01-01" if only the year is known.
Return ONLY a JSON array of objects with keys "date" (format YYYY-MM-DD) and "summary". If no specific historical dates or events are mentioned, return an empty array [].
Keep summaries extremely short (1 sentence).

Content:
${body}`;

    const timeline = await callGemini(prompt);
    if (timeline && Array.isArray(timeline) && timeline.length > 0) {
      console.log(`  -> Extracted ${timeline.length} timeline entries.`);

      let appendText = '\n\n## Timeline\n\n';
      for (const entry of timeline) {
        if (entry.date && entry.summary) {
          appendText += `- **${entry.date}** | ${entry.summary}\n`;
        }
      }

      let updatedContent = content;
      if (hasTimeline) {
        // Overwrite or append to existing timeline safely (here we append to end of file as a clean separate block)
        updatedContent = content.trim() + `\n\n## Timeline (AI-Extracted)\n\n` + appendText.replace('## Timeline\n\n', '');
      } else {
        updatedContent = content.trim() + appendText;
      }

      writeFileSync(file, updatedContent, 'utf-8');
      console.log(`  -> Successfully appended timeline entries.`);
      enrichedCount++;
      await delay(1000); // 1s throttle safeguard
    }
  }

  console.log(`\nEnriched ${enrichedCount} files with timeline entries.`);
}

(async () => {
  const force = args.includes('--force');
  if (command === 'tags') {
    await runTags(force);
  } else if (command === 'timeline') {
    await runTimeline(force);
  } else {
    console.log(`Unknown command: ${command}. Use "help" for usage info.`);
  }
})();
