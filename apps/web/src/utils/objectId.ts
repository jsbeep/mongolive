// 24자리 16진수 ObjectId 형태의 임의 식별자 생성 (timestamp 4byte + random 8byte)
export function generateObjectId(): string {
  const timestamp = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
  const random = Array.from({ length: 16 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${timestamp}${random}`;
}
