const fs = require('fs');
const file = 'E:/ai-work/claude-code-main/src/components/PromptInput/usePromptInputPlaceholder.ts';
let data = fs.readFileSync(file, 'utf8');
data = data.replace(/return `Message @\$\{displayName\}[^`]*`/g, 'return `Message @${displayName}...`');
fs.writeFileSync(file, data, 'utf8');
