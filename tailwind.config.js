/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        songa: {
          50: '#f5fbf8',
          100: '#e9f8f1',
          200: '#c8eedc',
          300: '#9be0c0',
          500: '#2ea66f',
          600: '#248d5d',
          700: '#1b7149',
          900: '#133f2f',
        },
        tupande: {
          50: '#f3f6ff',
          100: '#e8edf9',
          200: '#d7e4ff',
          500: '#3558d4',
          600: '#2447b3',
          900: '#111e46',
        },
        sand: {
          50: '#fffaf1',
          100: '#fff4dd',
          200: '#ffe0a8',
          500: '#f7b84c',
          700: '#d78811',
        },
      },
      boxShadow: {
        soft: '0 18px 45px rgba(17, 30, 70, 0.12)',
      },
    },
  },
  plugins: [],
};

