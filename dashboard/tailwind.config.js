/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#eef4ff', 100: '#d9e6ff', 200: '#bcd2ff', 300: '#8eb4ff',
          400: '#5a8bff', 500: '#3563e9', 600: '#234fd6', 700: '#1d3fae',
          800: '#1d388c', 900: '#1d3372',
        },
      },
    },
  },
  plugins: [],
  // antd owns its own reset; avoid Tailwind's preflight fighting it.
  corePlugins: { preflight: true },
}
