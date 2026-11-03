export function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // navigator.clipboard 미지원 환경(비-HTTPS 등) 대체 경로
  return new Promise((resolve, reject) => {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      document.execCommand('copy');
      resolve();
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}
