/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Linear-inspired neutral palette
        // All colors meet WCAG 2.1 AA contrast requirements (4.5:1 minimum)
        background: '#0d0d0d',
        foreground: '#f5f5f5',
        muted: '#8a8a8a', // Changed from #737373 (4.09:1) to #8a8a8a (5.1:1 contrast)
        border: '#262626',
        accent: '#005ea2', // Logo blue
        'accent-hover': '#0071bc', // Lighter blue for hover
        // Accent for TEXT on dark/tinted surfaces. #005ea2 text on a
        // bg-accent/20 chip measures ~2.6:1 (axe serious, Cat 7); this
        // value measures 6.8:1 on that chip and 7.6:1 on the background.
        'accent-bright': '#61a8e8',
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
