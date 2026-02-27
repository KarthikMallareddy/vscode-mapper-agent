const esbuild = require("esbuild");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',
    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd((result) => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                if (location) {
                    console.error(`    ${location.file}:${location.line}:${location.column}:`);
                }
            });
            console.log('[watch] build finished');
        });
    },
};

async function main() {
    const ctx = await esbuild.context({
        // Using path.join ensures it finds the files even if you're in the @MAPPER root
        entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
        bundle: true,
        format: 'cjs',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        platform: 'node',
        outfile: path.join(__dirname, 'dist', 'extension.js'),
        external: ['vscode'],
        logLevel: 'info', // Changed from 'silent' to 'info' so you can see errors
        plugins: [
            esbuildProblemMatcherPlugin,
        ],
    });

    if (watch) {
        await ctx.watch();
    } else {
        console.log("🚀 Building @mapper...");
        await ctx.rebuild();
        await ctx.dispose();
        console.log("✅ Build complete! Check your 'dist' folder.");
    }
}

main().catch(e => {
    console.error("❌ Build failed:");
    console.error(e);
    process.exit(1);
});