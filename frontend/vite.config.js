import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: { proxy: { '/extract-concepts': 'http://localhost:8000', '/extract-edges': 'http://localhost:8000', '/build-graph': 'http://localhost:8000' } },
});
