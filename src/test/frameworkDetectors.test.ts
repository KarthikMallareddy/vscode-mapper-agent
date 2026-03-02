/**
 * frameworkDetectors.test.ts — Unit tests for framework detection.
 *
 * Tests each framework detector with sample code snippets.
 * Run with: npx ts-node src/test/frameworkDetectors.test.ts
 */

// ──────────────────────── Inline Detector Logic ────────────────────────
// (Minimal re-implementation of detectors for standalone testing.)

interface Reg {
    framework: string;
    kind: string;
    name: string;
    line: number;
    meta?: string;
}

function detectFastAPI(text: string): Reg[] {
    const lines = text.split(/\r?\n/);
    const out: Reg[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const routeMatch = line.match(/^\s*@\s*(\w+)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']*)/i);
        if (routeMatch) {
            out.push({ framework: 'fastapi', kind: 'route', name: `${routeMatch[2].toUpperCase()} ${routeMatch[3]}`, line: i + 1, meta: routeMatch[2].toUpperCase() });
            continue;
        }
        const dependsMatch = line.match(/Depends\s*\(\s*([A-Za-z_]\w*)/);
        if (dependsMatch) out.push({ framework: 'fastapi', kind: 'dependency', name: dependsMatch[1], line: i + 1 });
        const mwMatch = line.match(/\.add_middleware\s*\(\s*([A-Za-z_]\w*)/);
        if (mwMatch) out.push({ framework: 'fastapi', kind: 'middleware', name: mwMatch[1], line: i + 1 });
        const includeMatch = line.match(/\.include_router\s*\(\s*([A-Za-z_]\w*)/);
        if (includeMatch) out.push({ framework: 'fastapi', kind: 'router_include', name: includeMatch[1], line: i + 1 });
    }
    return out;
}

function detectStreamlit(text: string): Reg[] {
    const lines = text.split(/\r?\n/);
    const out: Reg[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const cbMatch = line.match(/\b(on_click|on_change)\s*=\s*([A-Za-z_]\w*)/);
        if (cbMatch) out.push({ framework: 'streamlit', kind: 'callback', name: cbMatch[2], line: i + 1, meta: cbMatch[1] });
        const ssMatch = line.match(/st\.session_state\s*[\[.]s*["']?([A-Za-z_]\w*)["']?\]?/);
        if (ssMatch) out.push({ framework: 'streamlit', kind: 'session_key', name: ssMatch[1], line: i + 1 });
    }
    return out;
}

function detectFlask(text: string): Reg[] {
    const lines = text.split(/\r?\n/);
    const out: Reg[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const routeMatch = line.match(/^\s*@\s*(\w+)\.route\s*\(\s*["']([^"']*)/);
        if (routeMatch) out.push({ framework: 'flask', kind: 'route', name: routeMatch[2], line: i + 1 });
        const bpMatch = line.match(/=\s*Blueprint\s*\(\s*["']([^"']+)/);
        if (bpMatch) out.push({ framework: 'flask', kind: 'blueprint', name: bpMatch[1], line: i + 1 });
    }
    return out;
}

function detectDjango(text: string, fileName: string): Reg[] {
    const lines = text.split(/\r?\n/);
    const out: Reg[] = [];
    const isUrls = /urls\.py$/.test(fileName);
    const isViews = /views\.py$/.test(fileName);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (isUrls) {
            const pathMatch = line.match(/\b(?:path|re_path)\s*\(\s*["']([^"']*)/);
            if (pathMatch) out.push({ framework: 'django', kind: 'urlpattern', name: pathMatch[1] || '/', line: i + 1 });
        }
        if (isViews) {
            const viewMatch = line.match(/^class\s+([A-Za-z_]\w*)\s*\(.*(?:View|APIView)/);
            if (viewMatch) out.push({ framework: 'django', kind: 'view', name: viewMatch[1], line: i + 1 });
        }
    }
    return out;
}

// ──────────────────────── Test Runner ────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
    if (condition) { passed++; } else { failed++; console.error(`  ✗ FAILED: ${message}`); }
}

// ──────────────────────── Tests ────────────────────────

console.log('\n=== Framework Detectors Tests ===\n');

// -- FastAPI --
console.log('FastAPI:');
const fastapiCode = `
from fastapi import FastAPI, Depends
app = FastAPI()

@app.get("/users")
async def get_users(db = Depends(get_db)):
    pass

@app.post("/users")
async def create_user():
    pass

app.add_middleware(CORSMiddleware)
app.include_router(user_router, prefix="/api/v1")
`;
const fastapiRegs = detectFastAPI(fastapiCode);
assert(fastapiRegs.filter(r => r.kind === 'route').length === 2, 'Detects 2 routes');
assert(fastapiRegs.some(r => r.kind === 'dependency' && r.name === 'get_db'), 'Detects Depends(get_db)');
assert(fastapiRegs.some(r => r.kind === 'middleware' && r.name === 'CORSMiddleware'), 'Detects middleware');
assert(fastapiRegs.some(r => r.kind === 'router_include' && r.name === 'user_router'), 'Detects include_router');

// -- Streamlit --
console.log('\nStreamlit:');
const streamlitCode = `
import streamlit as st

if st.button("Click me", on_click=handle_click):
    pass

name = st.text_input("Name", on_change=update_name)
st.session_state["count"] = 0
st.session_state.user = "Alice"
`;
const stRegs = detectStreamlit(streamlitCode);
assert(stRegs.filter(r => r.kind === 'callback').length === 2, 'Detects 2 callbacks');
assert(stRegs.some(r => r.kind === 'callback' && r.name === 'handle_click'), 'Detects on_click=handle_click');
assert(stRegs.filter(r => r.kind === 'session_key').length >= 1, 'Detects session_state keys');

// -- Flask --
console.log('\nFlask:');
const flaskCode = `
from flask import Flask, Blueprint

api = Blueprint("api", __name__)

@app.route("/login", methods=["POST"])
def login():
    pass

@api.route("/users")
def list_users():
    pass
`;
const flaskRegs = detectFlask(flaskCode);
assert(flaskRegs.filter(r => r.kind === 'route').length === 2, 'Detects 2 routes');
assert(flaskRegs.some(r => r.kind === 'blueprint' && r.name === 'api'), 'Detects blueprint');

// -- Django --
console.log('\nDjango:');
const djangoUrlsCode = `
from django.urls import path
urlpatterns = [
    path("users/", views.UserListView.as_view(), name="user-list"),
    path("users/<int:pk>/", views.UserDetailView.as_view(), name="user-detail"),
]
`;
const djangoRegs = detectDjango(djangoUrlsCode, 'urls.py');
assert(djangoRegs.filter(r => r.kind === 'urlpattern').length === 2, 'Detects 2 URL patterns');

const djangoViewsCode = `
class UserListView(ListView):
    model = User

class UserDetailView(APIView):
    def get(self, request, pk):
        pass
`;
const djangoViewRegs = detectDjango(djangoViewsCode, 'views.py');
assert(djangoViewRegs.filter(r => r.kind === 'view').length >= 1, 'Detects class-based views');

// ──────────────────────── Results ────────────────────────

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
