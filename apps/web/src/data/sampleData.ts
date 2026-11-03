// path: src/data/sampleData.ts
import type { BsonObjectId, MockSnapshot } from '../types/explorer';

// 샘플은 아직 정규화 전의 입력이다(plain number, relaxed $date) — createDatabase를 거치면서
// 데이터 소스가 Canonical EJSON으로 바꿔 저장한다.
type RawObject = Record<string, unknown>;

// ── 샘플 데이터 ───────────────────────────────────────────────────────────────
// 하나의 상품 리뷰 포럼(Reddit 형태) 데이터를 두 가지 NoSQL 모델링으로 각각 내보낸다.
//
//   EJSON 샘플 — MongoDB 스타일 "embed" 모델
//     댓글 트리가 게시글 문서 안에 통째로 중첩된다. 참조는 ObjectId 하나로 끝나고
//     선언 없이도 전역 oid 탐색으로 따라간다.
//
//   JSON 샘플 — Firebase/HN API 스타일 "reference" 모델
//     같은 스레드가 collection 3개로 쪼개져 있고, 서로를 정수/문자열 ID로만 가리킨다.
//     참조 필드를 선언(referenceFields)해야 비로소 스레드가 이어진다.
//
// 시드(USER_SEEDS/POST_SEEDS)는 하나만 두고 두 빌더가 각자 변환한다 — 같은 데이터를
// 다르게 모델링했다는 게 이 파일 구조 자체로 드러나게 하려는 의도.

const SNAPSHOT_VERSION = 1;

export const FORUM_EJSON_DATABASE_NAME = 'review-forum';
export const FORUM_JSON_DATABASE_NAME = 'review-forum-json';

export const makeOid = (seed: string): BsonObjectId => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  const first = (hash >>> 0).toString(16).padStart(8, '0');
  const second = (Math.imul(hash ^ 0x9e3779b9, 0x85ebca6b) >>> 0).toString(16).padStart(8, '0');
  const third = (Math.imul(hash ^ 0xc2b2ae35, 0x27d4eb2f) >>> 0).toString(16).padStart(8, '0');

  return {
    $oid: `${first}${second}${third}`.slice(0, 24),
  };
};

const formatDate = (timestamp: number): string => new Date(timestamp).toISOString();
const toUnixSeconds = (timestamp: number): number => Math.floor(timestamp / 1000);

// 같은 샘플을 두 번 추가한 경우 '-copy'를 붙여 이름 충돌을 피한다.
const uniqueName = (base: string, existingNames: string[]): { name: string; isCopy: boolean } => {
  const isCopy = existingNames.includes(base);
  return { name: isCopy ? `${base}-copy` : base, isCopy };
};

// ── 시드 ──────────────────────────────────────────────────────────────────────

interface UserSeed {
  username: string;
  karma: number;
  about: string;
  // 일부 유저만 가진 필드 — 같은 컬렉션 안에서 문서 모양이 다른 걸 보여준다
  links?: Record<string, string>;
}

const USER_SEEDS: UserSeed[] = [
  { username: 'keeb_apologist', karma: 9134, about: '75% or nothing. I will die on this hill and it is a very small hill.', links: { site: 'thocc.report' } },
  { username: 'lumen_skeptic', karma: 3308, about: 'Photons owe me an explanation and I intend to collect.' },
  { username: 'sheet_counter', karma: 771, about: 'I count things so you do not have to. You are welcome.', links: { site: 'countedit.blog' } },
  { username: 'mug_truther', karma: 5102, about: 'The label said safe. The label lied. I have receipts.' },
  { username: 'hydration_nation', karma: 6455, about: 'Drinks water, reviews the vessel. It is a simple life.', links: { site: 'sip.reviews', video: 'tube.dev/@hydration' } },
  { username: 'gravity_denier', karma: 1890, about: 'Everything I own has fallen off something at least once.' },
  { username: 'warranty_lawyer', karma: 22740, about: 'Not a real lawyer. Have read every warranty printed since 2009.', links: { site: 'finepri.nt' } },
  { username: 'touch_grass_mod', karma: 14820, about: 'Moderator. Yes I saw your modmail. No.' },
];

interface CommentSeed {
  id: string;
  author: string;
  text: string;
  score: number;
  replies?: CommentSeed[];
}

interface PostSeed {
  id: string;
  kind: 'review' | 'text' | 'poll';
  channel: string;
  title: string;
  author: string;
  score: number;
  tags: string[];
  // kind에 따라 채워지는 묶음이 다르다 — schema-less의 핵심 데모
  product?: { name: string; price: number; category: string };
  rating?: number;
  wouldBuyAgain?: boolean;
  text?: string;
  options?: { label: string; votes: number }[];
  comments: CommentSeed[];
}

interface ChannelSeed {
  name: string;
  label: string;
  description: string;
  moderators: string[];
  // 채널마다 규칙 모양이 완전히 다르다
  rules: RawObject;
}

const CHANNEL_SEEDS: ChannelSeed[] = [
  {
    name: 'mildlyinfuriating',
    label: 'r/mildlyinfuriating',
    description: 'Off-by-two errors, but in physical products',
    moderators: ['touch_grass_mod', 'sheet_counter'],
    rules: { requiresPhoto: true, maxPostsPerDay: 2 },
  },
  {
    name: 'buyitforlife',
    label: 'r/buyitforlife',
    description: 'Things that outlived their warranty, allegedly',
    moderators: ['warranty_lawyer'],
    rules: { minOwnershipMonths: 12, allowPolls: true, bannedPhrases: ['affiliate link', 'DM for code'] },
  },
  {
    name: 'gadgets',
    label: 'r/gadgets',
    description: 'Hardware, and the people who are far too attached to it',
    moderators: ['keeb_apologist', 'touch_grass_mod', 'hydration_nation'],
    rules: { allowedFlairs: ['Review', 'Teardown', 'Rant'], autoFlagKeywords: ['game changer', 'life hack'] },
  },
];

const POST_SEEDS: PostSeed[] = [
  {
    id: 'p1',
    kind: 'review',
    channel: 'gadgets',
    title: 'Worst keyboard I have ever owned',
    author: 'keeb_apologist',
    score: 1204,
    tags: ['review', 'keyboards', 'regret'],
    product: { name: 'Halo Keyboard', price: 128, category: 'hardware' },
    rating: 5,
    wouldBuyAgain: true,
    comments: [
      {
        id: 'c1',
        author: 'touch_grass_mod',
        text: 'Rating of 5 and the title says worst. Explain yourself before I remove this.',
        score: 488,
        replies: [
          {
            id: 'c1-1',
            author: 'keeb_apologist',
            text: 'Hot-swappable switches, 75% layout, bluetooth that has never once dropped. 0/10 would buy again because I now physically cannot type on anything else without crying.',
            score: 812,
            replies: [
              {
                id: 'c1-1-1',
                author: 'gravity_denier',
                text: 'This is the most unhinged five star review on this sub and I am including the one about the toaster.',
                score: 390,
              },
            ],
          },
        ],
      },
      {
        id: 'c2',
        author: 'hydration_nation',
        text: 'Real ones know 75% > full-size. Fight me in the replies.',
        score: 264,
        replies: [
          {
            id: 'c2-1',
            author: 'warranty_lawyer',
            text: 'battery life on bluetooth though? asking for a friend who is also me',
            score: 121,
            replies: [
              {
                id: 'c2-1-1',
                author: 'keeb_apologist',
                text: '3 weeks. I forgot it even has a charging cable.',
                score: 305,
                replies: [
                  {
                    id: 'c2-1-1-1',
                    author: 'sheet_counter',
                    text: 'found the marketing department',
                    score: 577,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 'p2',
    kind: 'review',
    channel: 'mildlyinfuriating',
    title: '600 lumens but my room somehow got darker',
    author: 'lumen_skeptic',
    score: 733,
    tags: ['review', 'lighting', 'physics'],
    product: { name: 'Orbit Lamp', price: 72, category: 'home' },
    rating: 2,
    wouldBuyAgain: false,
    comments: [
      {
        id: 'c3',
        author: 'gravity_denier',
        text: 'Scientifically this should not be possible. Have you contacted NASA or just your landlord.',
        score: 341,
        replies: [
          {
            id: 'c3-1',
            author: 'lumen_skeptic',
            text: 'Both. NASA has not replied. The landlord replied with a photo of the light switch.',
            score: 604,
            replies: [
              {
                id: 'c3-1-1',
                author: 'touch_grass_mod',
                text: 'the landlord ate. no notes.',
                score: 288,
              },
            ],
          },
          {
            id: 'c3-2',
            author: 'keeb_apologist',
            text: 'skill issue, point it AT the desk and not at the wall like a caveman',
            score: 195,
          },
        ],
      },
      {
        id: 'c4',
        author: 'warranty_lawyer',
        text: 'The box says "up to 600 lumens". Up to. Zero is a number that is up to 600. I have seen this defense hold.',
        score: 412,
        replies: [
          {
            id: 'c4-1',
            author: 'lumen_skeptic',
            text: '...oh',
            score: 501,
          },
        ],
      },
    ],
  },
  {
    id: 'p3',
    kind: 'review',
    channel: 'mildlyinfuriating',
    title: 'Counted the sheets. It is 78. Not 80. I have been lied to.',
    author: 'sheet_counter',
    score: 987,
    tags: ['review', 'stationery', 'justice'],
    product: { name: 'Focus Pad', price: 24, category: 'stationery' },
    rating: 1,
    wouldBuyAgain: false,
    comments: [
      {
        id: 'c5',
        author: 'mug_truther',
        text: 'Box says 80 sheets. You counted three times. My trust in mankind is now also short by exactly two sheets.',
        score: 356,
        replies: [
          {
            id: 'c5-1',
            author: 'touch_grass_mod',
            text: 'this you sir? touch grass',
            score: 289,
            replies: [
              {
                id: 'c5-1-1',
                author: 'sheet_counter',
                text: 'the math checks out. class action when.',
                score: 447,
                replies: [
                  {
                    id: 'c5-1-1-1',
                    author: 'warranty_lawyer',
                    text: 'I am not a real lawyer but I will absolutely represent you for free out of spite.',
                    score: 690,
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        id: 'c6',
        author: 'gravity_denier',
        text: 'Counted mine. 81. I think I have your two and one from someone else. Reply if you are missing one.',
        score: 528,
      },
    ],
  },
  {
    id: 'p4',
    kind: 'review',
    channel: 'mildlyinfuriating',
    title: 'Box said microwave safe. Box was lying.',
    author: 'mug_truther',
    score: 654,
    tags: ['review', 'kitchen', 'betrayal'],
    product: { name: 'Cloud Mug', price: 18, category: 'home' },
    rating: 1,
    wouldBuyAgain: false,
    comments: [
      {
        id: 'c7',
        author: 'hydration_nation',
        text: 'it says microwave SAFE not microwave PROOF, use context clues',
        score: 233,
        replies: [
          {
            id: 'c7-1',
            author: 'mug_truther',
            text: 'found the guy who writes the warning labels',
            score: 588,
            replies: [
              {
                id: 'c7-1-1',
                author: 'warranty_lawyer',
                text: 'As someone who reads warning labels recreationally: he is correct and I hate it.',
                score: 372,
              },
            ],
          },
        ],
      },
      {
        id: 'c8',
        author: 'lumen_skeptic',
        text: 'RIP mug, RIP your coffee, RIP your Tuesday. Pour one out. Not in that mug obviously.',
        score: 421,
      },
    ],
  },
  {
    id: 'p5',
    kind: 'text',
    channel: 'buyitforlife',
    title: 'Has anything you bought actually outlived its warranty?',
    author: 'warranty_lawyer',
    score: 512,
    tags: ['discussion', 'bifl'],
    text: 'I have read approximately 4,000 warranties and I am starting to suspect they are written by people who know exactly how long the product lasts. Looking for counterexamples. Receipts encouraged but not required.',
    comments: [
      {
        id: 'c9',
        author: 'hydration_nation',
        text: 'Pulse Bottle. Six hour hike, ice still ice. Nothing funny to say, it just works.',
        score: 302,
        replies: [
          {
            id: 'c9-1',
            author: 'touch_grass_mod',
            text: 'found the bot account',
            score: 267,
            replies: [
              {
                id: 'c9-1-1',
                author: 'hydration_nation',
                text: 'I am a real person and I stand by my hydration.',
                score: 634,
              },
            ],
          },
        ],
      },
      {
        id: 'c10',
        author: 'gravity_denier',
        text: 'My Frame Stand is adjustable right up until it adjusts itself onto the floor at 2am. Three years running. Still going. So is my heart condition.',
        score: 318,
        replies: [
          {
            id: 'c10-1',
            author: 'sheet_counter',
            text: 'the fact your PHONE survived is the real plot twist here',
            score: 402,
          },
        ],
      },
    ],
  },
  {
    id: 'p6',
    kind: 'poll',
    channel: 'buyitforlife',
    title: 'Poll: which one of these betrayed you first?',
    author: 'touch_grass_mod',
    score: 289,
    tags: ['poll', 'bifl'],
    options: [
      { label: 'The stand, at 2am, onto hardwood', votes: 1284 },
      { label: 'The lamp, by simply not lamping', votes: 907 },
      { label: 'The mug, in the microwave, spectacularly', votes: 612 },
      { label: 'Nothing has betrayed me, I own three things', votes: 148 },
    ],
    comments: [
      {
        id: 'c11',
        author: 'mug_truther',
        text: 'Option 3 is worded like it was written by someone who watched it happen.',
        score: 244,
        replies: [
          {
            id: 'c11-1',
            author: 'touch_grass_mod',
            text: 'I moderate this sub. I have watched all four happen. Repeatedly.',
            score: 512,
            replies: [
              {
                id: 'c11-1-1',
                author: 'gravity_denier',
                text: 'sir this is a support group now',
                score: 389,
              },
            ],
          },
        ],
      },
      {
        id: 'c12',
        author: 'keeb_apologist',
        text: '148 people own three things and I need to know what the third one is.',
        score: 447,
      },
    ],
  },
];

// ── 공통 순회 ─────────────────────────────────────────────────────────────────

const walkComments = (seeds: CommentSeed[], visit: (seed: CommentSeed, depth: number) => void, depth = 0): void => {
  for (const seed of seeds) {
    visit(seed, depth);
    if (seed.replies) walkComments(seed.replies, visit, depth + 1);
  }
};

const countComments = (seeds: CommentSeed[]): number => {
  let total = 0;
  walkComments(seeds, () => { total += 1; });
  return total;
};

// ── EJSON 샘플 (embed 모델) ───────────────────────────────────────────────────

export const buildForumEjsonSample = (existingNames: string[] = []) => {
  const { name, isCopy } = uniqueName(FORUM_EJSON_DATABASE_NAME, existingNames);
  const now = Date.now();

  const userOid = (username: string) => makeOid(`user-${username}`);

  const users = USER_SEEDS.map((seed, index) => ({
    _id: userOid(seed.username),
    username: seed.username,
    karma: { $numberLong: String(seed.karma) },
    about: seed.about,
    createdAt: { $date: formatDate(now - (index + 3) * 86_400_000 * 37) },
    ...(seed.links ? { links: { ...seed.links } } : {}),
  }));

  const channels = CHANNEL_SEEDS.map((seed, index) => ({
    _id: makeOid(`channel-${seed.name}`),
    name: seed.name,
    label: seed.label,
    description: seed.description,
    // ObjectId 배열 — 배열 안쪽 요소에서 바로 유저 문서로 점프할 수 있다
    moderatorIds: seed.moderators.map(userOid),
    rules: structuredClone(seed.rules),
    createdAt: { $date: formatDate(now - (index + 1) * 86_400_000 * 200) },
  }));

  // 게시글 문서 안에 댓글 트리를 통째로 중첩한다 (embed 모델)
  const buildEmbeddedComments = (seeds: CommentSeed[], depth: number): RawObject[] =>
    seeds.map((seed, index) => {
      const nested = seed.replies ? buildEmbeddedComments(seed.replies, depth + 1) : [];
      return {
        _id: makeOid(`comment-${seed.id}`),
        authorId: userOid(seed.author),
        text: seed.text,
        score: { $numberLong: String(seed.score) },
        createdAt: { $date: formatDate(now - depth * 3_600_000 - index * 900_000) },
        ...(nested.length > 0 ? { replies: nested } : {}),
      };
    });

  const posts = POST_SEEDS.map((seed, index) => {
    const base = {
      _id: makeOid(`post-${seed.id}`),
      kind: seed.kind,
      title: seed.title,
      authorId: userOid(seed.author),
      channelId: makeOid(`channel-${seed.channel}`),
      score: { $numberLong: String(seed.score) },
      tags: [...seed.tags],
      commentCount: { $numberLong: String(countComments(seed.comments)) },
      createdAt: { $date: formatDate(now - index * 21_600_000) },
    };

    // kind마다 채워지는 필드가 다르다 — 같은 컬렉션, 다른 문서 모양
    const variant: RawObject =
      seed.kind === 'review' ? {
        product: {
          name: seed.product!.name,
          price: { $numberDecimal: seed.product!.price.toFixed(2) },
          category: seed.product!.category,
        },
        rating: { $numberLong: String(seed.rating!) },
        wouldBuyAgain: seed.wouldBuyAgain!,
      }
      : seed.kind === 'text' ? { text: seed.text! }
      : {
          options: seed.options!.map((option) => ({
            label: option.label,
            votes: { $numberLong: String(option.votes) },
          })),
          closesAt: { $date: formatDate(now + 4 * 86_400_000) },
        };

    return { ...base, ...variant, comments: buildEmbeddedComments(seed.comments, 1) };
  });

  return {
    name,
    label: isCopy ? 'Review Forum · EJSON (Copy)' : 'Review Forum · EJSON',
    description:
      'A product-review forum modeled the MongoDB way — comment threads embedded inside each post, references as bare ObjectIds, and canonical EJSON types ($oid, $date, $numberDecimal, $numberLong)',
    collections: {
      posts: {
        name: 'posts',
        label: 'Posts',
        description: 'Review / discussion / poll posts — each kind carries a different set of fields, with the whole comment tree embedded',
        documents: posts,
        updatedAt: now - 600_000,
        titleKey: 'title',
      },
      users: {
        name: 'users',
        label: 'Users',
        description: 'Every authorId in this database points here — click any ObjectId to land on the author',
        documents: users,
        updatedAt: now - 3_600_000,
        titleKey: 'username',
      },
      channels: {
        name: 'channels',
        label: 'Channels',
        description: 'Subreddits with per-channel rules of differing shape, plus a moderatorIds array you can drill into',
        documents: channels,
        updatedAt: now - 7_200_000,
        titleKey: 'label',
      },
    },
  };
};

// ── JSON 샘플 (reference 모델) ────────────────────────────────────────────────

export const buildForumJsonSample = (existingNames: string[] = []) => {
  const { name, isCopy } = uniqueName(FORUM_JSON_DATABASE_NAME, existingNames);
  const now = Date.now();

  // HN Firebase API처럼 모든 아이템이 하나의 정수 ID 공간을 공유한다.
  let nextId = 8801;
  const commentIds = new Map<string, number>();
  const storyIds = new Map<string, number>();

  for (const seed of POST_SEEDS) {
    storyIds.set(seed.id, nextId);
    nextId += 1;
  }
  for (const seed of POST_SEEDS) {
    walkComments(seed.comments, (comment) => {
      commentIds.set(comment.id, nextId);
      nextId += 1;
    });
  }

  const stories = POST_SEEDS.map((seed, index) => {
    const variant: RawObject =
      seed.kind === 'review' ? {
        product: { name: seed.product!.name, price: seed.product!.price, category: seed.product!.category },
        rating: seed.rating!,
        wouldBuyAgain: seed.wouldBuyAgain!,
      }
      : seed.kind === 'text' ? { text: seed.text! }
      : { options: seed.options!.map((option) => ({ label: option.label, votes: option.votes })) };

    return {
      id: storyIds.get(seed.id)!,
      type: seed.kind === 'review' ? 'review' : seed.kind === 'poll' ? 'poll' : 'story',
      by: seed.author,
      title: seed.title,
      score: seed.score,
      time: toUnixSeconds(now - index * 21_600_000),
      descendants: countComments(seed.comments),
      tags: [...seed.tags],
      ...variant,
      // 자식 댓글을 ID로만 가리킨다 — 스레드를 보려면 참조를 따라가야 한다
      kids: (seed.comments ?? []).map((comment) => commentIds.get(comment.id)!),
    };
  });

  const comments: RawObject[] = [];
  for (const seed of POST_SEEDS) {
    const storyId = storyIds.get(seed.id)!;
    walkComments(seed.comments, (comment, depth) => {
      comments.push({
        id: commentIds.get(comment.id)!,
        type: 'comment',
        by: comment.author,
        story: storyId,
        text: comment.text,
        score: comment.score,
        time: toUnixSeconds(now - depth * 3_600_000),
        kids: (comment.replies ?? []).map((reply) => commentIds.get(reply.id)!),
      });
    });
  }

  const submittedBy = new Map<string, number[]>();
  for (const seed of POST_SEEDS) {
    const list = submittedBy.get(seed.author) ?? [];
    list.push(storyIds.get(seed.id)!);
    submittedBy.set(seed.author, list);
  }

  const users = USER_SEEDS.map((seed, index) => ({
    id: seed.username,
    created: toUnixSeconds(now - (index + 3) * 86_400_000 * 37),
    karma: seed.karma,
    about: seed.about,
    ...(seed.links ? { links: { ...seed.links } } : {}),
    submitted: submittedBy.get(seed.username) ?? [],
  }));

  return {
    name,
    label: isCopy ? 'Review Forum · JSON (Copy)' : 'Review Forum · JSON',
    description:
      'The same forum modeled the Firebase/HN API way — plain JSON with no type wrappers, split across three collections that only know each other by id. Reference fields are pre-declared, so kids/submitted/by are all clickable.',
    collections: {
      stories: {
        name: 'stories',
        label: 'Stories',
        description: 'Top-level reviews and discussions. kids[] holds comment ids — follow them to rebuild the thread',
        documents: stories,
        updatedAt: now - 600_000,
        titleKey: 'title',
        primaryKey: 'id',
        referenceFields: {
          by: { targetCollection: 'users', targetKey: 'id' },
          kids: { targetCollection: 'comments', targetKey: 'id' },
        },
      },
      comments: {
        name: 'comments',
        label: 'Comments',
        description: 'Flat collection — nesting exists only as kids[] id arrays pointing at other comments',
        documents: comments,
        updatedAt: now - 900_000,
        titleKey: 'text',
        primaryKey: 'id',
        referenceFields: {
          by: { targetCollection: 'users', targetKey: 'id' },
          story: { targetCollection: 'stories', targetKey: 'id' },
          kids: { targetCollection: 'comments', targetKey: 'id' },
        },
      },
      users: {
        name: 'users',
        label: 'Users',
        description: 'Keyed by username, not an ObjectId — submitted[] closes the loop back to stories',
        documents: users,
        updatedAt: now - 3_600_000,
        titleKey: 'id',
        primaryKey: 'id',
        referenceFields: {
          submitted: { targetCollection: 'stories', targetKey: 'id' },
        },
      },
    },
  };
};

export const createEmptyWorkspaceSnapshot = (): MockSnapshot => {
  const now = Date.now();
  return {
    version: SNAPSHOT_VERSION,
    activeDatabase: 'workspace',
    databases: {
      workspace: {
        name: 'workspace',
        label: 'Workspace',
        description: '',
        collections: {},
        updatedAt: now,
      },
    },
    updatedAt: now,
  };
};
