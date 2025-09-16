import fs from 'fs';

// Load EasyList (download from https://easylist.to/easylist/easylist.txt first)
const easylist = fs.readFileSync('easylist.txt', 'utf8').split('\n');

let rules = [];
let id = 1;
const MAX_RULES = 30000; // Chrome’s hard cap

// Function to remove non-ASCII characters from filters
function sanitizeFilter(str) {
  return str.replace(/[^\x00-\x7F]/g, "");
}

for (const rule of easylist) {
  if (id > MAX_RULES) break; // stop once we hit 30k

  if (!rule || rule.startsWith('!') || rule.startsWith('##') || rule.startsWith('#@#')) continue;

  const cleanedFilter = sanitizeFilter(rule.replace(/^(\|\|?)/, ''));

  if (!cleanedFilter) continue; // skip empty filters after cleanup

  rules.push({
    id: id++,
    priority: 1,
    action: { type: 'block' },
    condition: {
      urlFilter: cleanedFilter,
      resourceTypes: [
        "main_frame",
        "sub_frame",
        "script",
        "image",
        "xmlhttprequest"
      ]
    }
  });
}

fs.writeFileSync('rules.json', JSON.stringify(rules, null, 2));
console.log(`✅ rules.json generated successfully with ${rules.length} rules (capped at ${MAX_RULES})`);
