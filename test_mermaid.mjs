import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: false });

const graph = `flowchart TD
  subgraph sg_Frontend[Frontend]
    direction TB
    domNode_1([mobile/src/screens/RegisterScreen.tsx])
    domNode_2([frontend/app/login/page.tsx])
  end
  domNode_1 --> domNode_2

%% Styling injected by @mapper
classDef frontend fill:#bbf7d0,stroke:#059669,stroke-width:2px,color:#064e3b,font-weight:bold;
class domNode_1,domNode_2 frontend;
`;

async function test() {
    try {
        await mermaid.parse(graph);
        console.log("SUCCESS parsed graph");
    } catch (e) {
        console.error("ERROR:", e.message);
    }
}
test();
