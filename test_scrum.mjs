const fs = require('fs');
const cp = require('child_process');
const rawLog = cp.execSync('git log -n 5 --format="%H@@@%an@@@%s" --date=short').toString().trim();
const commits = rawLog.split('\n').filter(Boolean).map(line => {
    const parts = line.split('@@@');
    return { hash: parts[0], author: parts[1], msg: parts.slice(2).join('@@@') };
});
const goals = JSON.parse(fs.readFileSync('./.mapper/scrum.json', 'utf8'));
console.log(JSON.stringify(commits, null, 2));
console.log(JSON.stringify(goals.filter(g => !g.completed), null, 2));
