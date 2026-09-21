const fs = require('node:fs');
const path = require('node:path');

const inputPath = path.join(__dirname, 'easylist.txt');
const outputPath = path.join(__dirname, '..', 'rules', 'rules.json');

const easylist = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/);

const rules = [];
let id = 1;
const MAX_RULES = 30000;

const resourceTypes = [
  'main_frame',
  'sub_frame',
  'script',
  'image',
  'xmlhttprequest'
];

function domainFromEasyListRule(rule) {
  const value = rule.trim();

  // Skip unsupported EasyList syntax rather than generating unsafe rules.
  if (
    !value ||
    value.startsWith('!') ||
    value.startsWith('@@') ||
    value.includes('#') ||
    value.startsWith('/') ||
    value.includes('$')
  ) {
    return null;
  }

  const match = value.match(
    /^\|\|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)\^?$/i
  );

  if (!match) return null;

  try {
    const hostname = new URL(`https://${match[1]}`).hostname;
    return hostname === match[1].toLowerCase() ? hostname : null;
  } catch {
    return null;
  }
}

for (const rule of easylist) {
  if (rules.length >= MAX_RULES) break;

  const hostname = domainFromEasyListRule(rule);
  if (!hostname) continue;

  rules.push({
    id: id++,
    priority: 1,
    action: { type: 'block' },
    condition: {
      urlFilter: `||${hostname}^`,
      resourceTypes
    }
  });
}

fs.writeFileSync(outputPath, JSON.stringify(rules, null, 2));

console.log(
  `Generated ${rules.length} validated domain rules at ${outputPath}.`
);