import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

async function main() {
  const [,, targetPath, linkedinUrl, rolesSummary] = process.argv;

  if (!targetPath || !linkedinUrl) {
    console.error('Usage: bun run scripts/enrich-linkedin.ts <path-to-markdown> <linkedin-url> [roles-summary]');
    process.exit(1);
  }

  const fullPath = path.resolve(targetPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  let fileContent = fs.readFileSync(fullPath, 'utf8');
  
  // Use gray-matter to parse
  const parsed = matter(fileContent);
  const data = parsed.data;

  // Add alias
  if (!data.aliases) {
    data.aliases = [];
  }
  if (!data.aliases.includes(linkedinUrl)) {
    data.aliases.push(linkedinUrl);
  }

  let content = parsed.content;

  // Update State section if rolesSummary provided
  if (rolesSummary) {
    const stateRegex = /## State\n([\s\S]*?)(?=\n## |$)/;
    const match = content.match(stateRegex);
    
    if (match) {
      let stateContent = match[1];
      if (!stateContent.includes('LinkedIn:')) {
        stateContent = stateContent.trim() + `\n- LinkedIn: [Profile](${linkedinUrl})\n- Current Role: ${rolesSummary}\n`;
        content = content.replace(stateRegex, `## State\n${stateContent}\n`);
      }
    } else {
      // Append State if not found
      content += `\n## State\n- LinkedIn: [Profile](${linkedinUrl})\n- Current Role: ${rolesSummary}\n`;
    }
  }

  // Write back
  const newFileContent = matter.stringify(content, data);
  fs.writeFileSync(fullPath, newFileContent);
  console.log(`Successfully updated ${fullPath}`);
}

main().catch(console.error);
