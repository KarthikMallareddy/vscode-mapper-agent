import fs from 'fs';

async function testAll() {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM();
    global.window = dom.window;
    global.document = dom.window.document;

    // Polyfill DOMPurify
    global.DOMPurify = { addHook: () => { } };

    const mermaidMod = await import('mermaid');
    const mermaid = mermaidMod.default || mermaidMod;
    mermaid.initialize({ startOnLoad: false });

    const data = JSON.parse(fs.readFileSync('debug_mermaid.json', 'utf8'));

    for (const [key, graph] of Object.entries(data)) {
        try {
            await mermaid.parse(graph);
            console.log(`[OK] ${key}`);
        } catch (e) {
            console.error(`[ERROR] ${key}:`, e.message.split('\n')[0]);
        }
    }
}
testAll();
