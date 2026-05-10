import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

async function main() {
  const [,, targetPath, linkedinUrl, rawJsonPayload] = process.argv;

  if (!targetPath || !linkedinUrl || !rawJsonPayload) {
    console.error('Usage: bun run scripts/enrich-linkedin.ts <path-to-markdown> <linkedin-url> <json-payload>');
    process.exit(1);
  }

  const fullPath = path.resolve(targetPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`File not found: ${fullPath}`);
    process.exit(1);
  }

  const parsedJson = JSON.parse(rawJsonPayload);
  
  // 1. Update the Main Person Page
  let fileContent = fs.readFileSync(fullPath, 'utf8');
  const parsed = matter(fileContent);
  const data = parsed.data;

  // Add alias
  if (!data.aliases) data.aliases = [];
  if (!data.aliases.includes(linkedinUrl)) data.aliases.push(linkedinUrl);

  let content = parsed.content;

  // Determine slug for the new profile file
  const slug = path.basename(fullPath, '.md');
  const profileFileName = `${slug}-linkedin.md`;
  const profileFilePath = path.join(path.dirname(fullPath), 'linkedin-profiles', profileFileName);

  // Build the state snippet
  const rolesSummary = parsedJson.currentRole || parsedJson.headline || "Role info unavailable";
  const location = parsedJson.location ? `\n- Location: ${parsedJson.location}` : "";
  const education = parsedJson.education ? `\n- Education: ${parsedJson.education}` : "";
  
  const newStateContent = `- LinkedIn: [Profile](${linkedinUrl}) | [Raw Extraction](linkedin-profiles/${profileFileName})\n- Current Role: ${rolesSummary}${location}${education}\n`;

  const stateRegex = /## State\n([\s\S]*?)(?=\n## |$)/;
  const match = content.match(stateRegex);
  
  if (match) {
    let stateContent = match[1];
    // Remove old linkedin lines to avoid duplicates
    stateContent = stateContent.split('\n').filter(l => !l.includes('- LinkedIn:') && !l.includes('- Current Role:') && !l.includes('- Location:') && !l.includes('- Education:')).join('\n');
    stateContent = stateContent.trim() + `\n${newStateContent}`;
    content = content.replace(stateRegex, `## State\n${stateContent}\n`);
  } else {
    content += `\n## State\n${newStateContent}`;
  }

  // Write back main file
  const newFileContent = matter.stringify(content, data);
  fs.writeFileSync(fullPath, newFileContent);

  // 2. Create the raw profile file
  const profileDir = path.dirname(profileFilePath);
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  const profileFrontmatter = {
    type: "linkedin-profile",
    title: `LinkedIn: ${data.title || slug}`,
    person: `../${slug}.md`,
    url: linkedinUrl,
    extracted_at: new Date().toISOString()
  };

  let profileContent = `# LinkedIn Profile: ${data.title || slug}\n\n`;
  profileContent += `This is the raw LinkedIn extraction for [${data.title || slug}](../${slug}.md).\n\n`;
  profileContent += `## Extracted Data\n\n`;
  
  for (const [key, value] of Object.entries(parsedJson)) {
    profileContent += `### ${key}\n${value}\n\n`;
  }

  const newProfileFileContent = matter.stringify(profileContent, profileFrontmatter);
  fs.writeFileSync(profileFilePath, newProfileFileContent);

  console.log(`Successfully updated ${fullPath} and created ${profileFilePath}`);
}

main().catch(console.error);
