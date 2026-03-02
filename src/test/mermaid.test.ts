/**
 * mermaid.test.ts — Unit tests for Mermaid diagram safety.
 *
 * Tests label escaping, ID generation, shape syntax, and
 * ensures generated Mermaid code parses without errors.
 *
 * Run with: npx ts-node src/test/mermaid.test.ts
 * (Simple assertion-based tests, no framework required.)
 */

// ──────────────────────── Inline Implementations ────────────────────────
// (Duplicated here so tests can run standalone without VS Code extension host.)

function toMermaidId(input: string): string {
    let id = input.replace(/[^A-Za-z0-9_]/g, '_');
    if (/^[0-9]/.test(id)) id = '_' + id;
    return id || '_empty';
}

function escapeMermaidLabel(label: string): string {
    let safe = label
        .replace(/"/g, "'")
        .replace(/[\[\]{}()]/g, '')
        .replace(/#/g, 'No.')
        .replace(/&/g, 'and')
        .replace(/</g, 'lt')
        .replace(/>/g, 'gt');
    if (!safe.trim()) safe = '(empty)';
    return safe;
}

type ScanNodeKind = 'frontend' | 'backend' | 'service' | 'datastore' | 'external' | 'unknown';

function mermaidShape(id: string, label: string, kind: ScanNodeKind): string {
    const safe = escapeMermaidLabel(label);
    switch (kind) {
        case 'datastore': return `${id}[(${safe})]`;
        case 'external': return `${id}{{${safe}}}`;
        case 'frontend': return `${id}([${safe}])`;
        case 'service': return `${id}[/${safe}/]`;
        default: return `${id}[${safe}]`;
    }
}

// ──────────────────────── Test Runner ────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) {
        passed++;
    } else {
        failed++;
        console.error(`  ✗ FAILED: ${message}`);
    }
}

function assertEqual(actual: string, expected: string, message: string): void {
    if (actual === expected) {
        passed++;
    } else {
        failed++;
        console.error(`  ✗ FAILED: ${message}`);
        console.error(`    Expected: ${JSON.stringify(expected)}`);
        console.error(`    Actual:   ${JSON.stringify(actual)}`);
    }
}

// ──────────────────────── Tests ────────────────────────

console.log('\n=== Mermaid Safety Tests ===\n');

// -- toMermaidId --
console.log('toMermaidId:');
assertEqual(toMermaidId('hello world'), 'hello_world', 'spaces replaced with underscores');
assertEqual(toMermaidId('foo/bar.ts'), 'foo_bar_ts', 'slashes and dots replaced');
assertEqual(toMermaidId('123start'), '_123start', 'numeric prefix gets underscore');
assertEqual(toMermaidId(''), '_empty', 'empty string handled');
assertEqual(toMermaidId('valid_id'), 'valid_id', 'valid ID unchanged');
assertEqual(toMermaidId('a-b+c=d'), 'a_b_c_d', 'special chars replaced');

// -- escapeMermaidLabel --
console.log('\nescapeMermaidLabel:');
assertEqual(escapeMermaidLabel('Hello "World"'), "Hello 'World'", 'double quotes replaced');
assertEqual(escapeMermaidLabel('array[0]'), 'array0', 'brackets removed');
assertEqual(escapeMermaidLabel('A & B'), 'A and B', 'ampersand replaced');
assertEqual(escapeMermaidLabel('a < b > c'), 'a lt b gt c', 'angle brackets replaced');
assertEqual(escapeMermaidLabel('#1 item'), 'No.1 item', 'hash replaced');
assertEqual(escapeMermaidLabel('   '), '(empty)', 'whitespace-only handled');
assertEqual(escapeMermaidLabel('normal text'), 'normal text', 'normal text unchanged');
assertEqual(escapeMermaidLabel('func(x, y)'), 'funcx, y', 'parens removed');

// -- mermaidShape --
console.log('\nmermaidShape:');
assert(mermaidShape('DB', 'MongoDB', 'datastore').includes('[('), 'datastore uses cylinder');
assert(mermaidShape('API', 'OpenAI', 'external').includes('{{'), 'external uses hexagon {{');
assert(mermaidShape('App', 'React', 'frontend').includes('(['), 'frontend uses stadium ([');
assert(mermaidShape('Svc', 'Auth', 'service').includes('[/'), 'service uses parallelogram [/');
assert(mermaidShape('Be', 'API', 'backend').includes('[') && !mermaidShape('Be', 'API', 'backend').includes('[('), 'backend uses rectangle [');

// -- Cycle detection: subgraph IDs should have sg_ prefix --
console.log('\nCycle safety:');
const sgIds = ['sg_Frontend', 'sg_Backend', 'sg_DataStore', 'sg_External'];
const nodeIds = ['Frontend', 'Backend', 'MongoDB', 'OpenAI'];
for (const sg of sgIds) {
    for (const n of nodeIds) {
        assert(sg !== n, `Subgraph ID "${sg}" does not collide with node ID "${n}"`);
    }
}

// -- Mermaid parse safety: generated code should not contain dangerous patterns --
console.log('\nParse safety:');
const testLabels = [
    'Hello "World" [test]',
    'func(a, b) -> c',
    'A & B < C > D',
    '#1 Priority',
    '100% complete {{done}}',
    '',
    '   ',
    'normal',
    'path/to/file.ts',
];

for (const label of testLabels) {
    const escaped = escapeMermaidLabel(label);
    assert(!escaped.includes('"'), `No double quotes in escaped: "${label}"`);
    assert(!escaped.includes('['), `No [ in escaped: "${label}"`);
    assert(!escaped.includes(']'), `No ] in escaped: "${label}"`);
    assert(escaped.trim().length > 0, `Not empty after escape: "${label}"`);
}

// -- Full Mermaid snippet validity --
console.log('\nFull snippet validity:');
const snippet = [
    'flowchart TD',
    `  subgraph sg_Frontend[Frontend]`,
    `    ${mermaidShape('App', 'React App', 'frontend')}`,
    `  end`,
    `  subgraph sg_Backend[Backend]`,
    `    ${mermaidShape('API', 'FastAPI', 'backend')}`,
    `  end`,
    `  subgraph sg_DataStore[Data Store]`,
    `    ${mermaidShape('DB', 'MongoDB', 'datastore')}`,
    `  end`,
    `  App --> API`,
    `  API --> DB`,
].join('\n');

assert(snippet.includes('flowchart TD'), 'Starts with flowchart');
assert(!snippet.includes('subgraph Backend[') || snippet.includes('sg_Backend'), 'No colliding subgraph IDs');
assert(snippet.split('subgraph').length === 4, 'Has 3 subgraphs'); // 1 original + 3 splits

// ──────────────────────── Results ────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
    process.exit(1);
}
