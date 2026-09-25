import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
    plugins: [react()],
    server: {
        proxy: {
            '/extract-concepts': 'http://localhost:8000',
            '/extract-edges': 'http://localhost:8000',
            '/merge-concepts': 'http://localhost:8000',
            '/build-graph': 'http://localhost:8000',
            '/generate-quiz': 'http://localhost:8000',
            '/evaluate-quiz': 'http://localhost:8000',
            '/generate-path': 'http://localhost:8000',
            '/concept-explanation': 'http://localhost:8000',
            '/retest-concept': 'http://localhost:8000',
            '/evaluate-retest': 'http://localhost:8000',
            '/health': 'http://localhost:8000',
        },
    },
});
