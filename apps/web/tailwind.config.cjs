/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: '#ffffff',
          soft: '#f8fafc',
          muted: '#eef2f7'
        },
        accent: {
          DEFAULT: '#22c55e',
          soft: '#dcfce7',
          strong: '#16a34a'
        },
        status: {
          online: '#22c55e',
          offline: '#64748b',
          warning: '#f59e0b'
        }
      },
      boxShadow: {
        soft: '0 1px 10px rgba(15, 23, 42, 0.04)',
        panel: '0 1px 18px rgba(188, 194, 195, 0.16)',
        elevated: '0 14px 30px rgba(15, 23, 42, 0.1)',
        glow: '0 0 0 1px rgba(34, 197, 94, 0.12), 0 16px 36px rgba(34, 197, 94, 0.14)'
      },
      backgroundImage: {
        'grid-fade': 'radial-gradient(circle at center, rgba(34, 197, 94, 0.12), transparent 42%), linear-gradient(180deg, #f0f4f8, rgba(243, 247, 251, 1))'
      }
    }
  },
  plugins: []
};
