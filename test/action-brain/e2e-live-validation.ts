/**
 * End-to-end live validation: real WhatsApp messages → Action Brain extractor
 *
 * Feeds 13 real messages from wacli SQLite through the commitment extractor
 * and evaluates accuracy against manually labeled expectations.
 *
 * Run: source ~/.zshrc && bun run test/action-brain/e2e-live-validation.ts
 */

import { extractCommitments, type WhatsAppMessage, type StructuredCommitment } from '../../src/action-brain/extractor.ts';

interface GoldSetEntry {
  message: WhatsAppMessage;
  expectedCommitments: Array<{
    who: string;
    action: string; // substring match on owes_what
    type: string;
  }>;
}

const GOLD_SET: GoldSetEntry[] = [
  {
    message: {
      MsgID: 'AC7991B81A649C77F914AD27E6DB6FFF',
      ChatName: 'Joe MacPherson',
      SenderName: 'Joe MacPherson',
      Timestamp: '2026-04-15T20:02:23Z',
      Text: 'Sounds good. Just nominate a time and I will meet you guys in the resto, where the bar is.',
    },
    expectedCommitments: [
      { who: 'Joe MacPherson', action: 'meet', type: 'waiting_on' },
    ],
  },
  {
    message: {
      MsgID: 'A5A28866ED77D7AD212E303269ECDBEF',
      ChatName: 'Parathan',
      SenderName: 'Parathan',
      Timestamp: '2026-04-15T20:35:27Z',
      Text: 'Booked hotel for Joe, heading back to meet him now\n\nGot bank account access but otp will work 24 hours from now',
    },
    expectedCommitments: [
      { who: 'Parathan', action: 'hotel', type: 'waiting_on' },
      { who: 'Parathan', action: 'bank account', type: 'waiting_on' },
    ],
  },
  {
    message: {
      MsgID: '3A2F4B47DBF612141C95',
      ChatName: 'Parathan',
      SenderName: 'Abbhinaav',
      Timestamp: '2026-04-15T23:06:31Z',
      Text: "Bro, we have to sit down tonight itself. I will tell you when we are on our way back because we are not sure if Sagar will be back in time for the meeting Joe before he flies to keyrwa",
    },
    expectedCommitments: [
      { who: 'Abbhinaav', action: 'sit down', type: 'owed_by_me' },
    ],
  },
  {
    message: {
      MsgID: '3B9B1D7349473CCBB6ED',
      ChatName: 'Parathan',
      SenderName: 'Parathan',
      Timestamp: '2026-04-15T23:09:00Z',
      Text: "I managed to get Mobile OTP set up, it will be active from 3pm tomorrow onwards\n\nSagar Patel is yet to get his phone set up with Josephina's account.",
    },
    expectedCommitments: [
      { who: 'Sagar Patel', action: 'phone', type: 'waiting_on' },
    ],
  },
  {
    message: {
      MsgID: '3B745E82E325DDD5DBD6',
      ChatName: 'Parathan',
      SenderName: 'Parathan',
      Timestamp: '2026-04-16T02:20:45Z',
      Text: 'Will be contacting the places to visit tomorrow morning and heading in to check them out same day',
    },
    expectedCommitments: [
      { who: 'Parathan', action: 'contact', type: 'waiting_on' },
    ],
  },
  {
    message: {
      MsgID: '3B74E87B3E4EA12D491C',
      ChatName: 'Parathan',
      SenderName: 'Parathan',
      Timestamp: '2026-04-16T04:31:11Z',
      Text: 'Is ~10am good for a breakfast chat with Joe for you? I think you need to have the chat regarding the geo interviews with him',
    },
    expectedCommitments: [
      { who: 'Abbhinaav', action: 'chat', type: 'owed_by_me' },
    ],
  },
  {
    message: {
      MsgID: '3A099ACDC1F8852C7742',
      ChatName: 'Parathan',
      SenderName: 'Abbhinaav',
      Timestamp: '2026-04-16T05:34:42Z',
      Text: 'Bro make sure to take Sagar patel with you',
    },
    expectedCommitments: [
      { who: 'Parathan', action: 'Sagar', type: 'waiting_on' },
    ],
  },
  {
    message: {
      MsgID: '2ADAE26D5343E0877C1C',
      ChatName: 'Vivian',
      SenderName: 'Vivian',
      Timestamp: '2026-04-16T09:51:30Z',
      Text: "Hello Abhinav,\nThe landlord is chasing for the signed TA and payment ……. \nKindly assist to sign today.   Thank you.   Have a nice weekend!   \n\nDear Vivian,\n \nPlease let us know when payment is complete. \nIn addition, we require the Tenant to counter wet ink sign the TA against his digital signatories when he is back. The wet ink signed TA should be provided to us before the lease commencement.\n \nThank you.",
    },
    expectedCommitments: [
      { who: 'Abbhinaav', action: 'sign', type: 'owed_by_me' },
      { who: 'Abbhinaav', action: 'payment', type: 'owed_by_me' },
    ],
  },
  {
    message: {
      MsgID: '3EB00EA84CF3264910F885',
      ChatName: 'tenorioerwin30',
      SenderName: 'tenorioerwin30',
      Timestamp: '2026-04-16T10:18:23Z',
      Text: 'Dear customer, SGD126.84 is overdue for 4 days. Please pay immediately to unlock your app. You can visit our FAQs on your App for more info. Thank you.',
    },
    expectedCommitments: [
      { who: 'Abbhinaav', action: 'pay', type: 'owed_by_me' },
    ],
  },
  {
    message: {
      MsgID: 'A5DCF2F0D59B15C565A8B2EF1D03CFBE',
      ChatName: 'Parathan',
      SenderName: 'Parathan',
      Timestamp: '2026-04-16T14:52:19Z',
      Text: 'Alright will let Joe know 👍',
    },
    expectedCommitments: [
      { who: 'Parathan', action: 'Joe', type: 'waiting_on' },
    ],
  },
  {
    message: {
      MsgID: '3EB028621FBCEFD44B1FB4',
      ChatName: 'KAGERA TIN- ACCOUNT',
      SenderName: 'Sagar Patel',
      Timestamp: '2026-04-16T19:53:43Z',
      Text: '@31538146189329 THIS PAYMENT I INITIATED TO MR. MUKESH VIA CRDB  3.2M TZS Pls check and authorised as Trial payment',
    },
    expectedCommitments: [
      { who: 'Abbhinaav', action: 'authoris', type: 'owed_by_me' },
    ],
  },
  {
    message: {
      MsgID: 'AC3F8A98EBF583C91FF222633639716B',
      ChatName: 'KAGERA TIN- ACCOUNT',
      SenderName: 'Vidyasagar',
      Timestamp: '2026-04-16T20:05:55Z',
      Text: '@165914603471039 @151140335358101 . internet banking access have been given to Parathan & Sagar patel \n\n(1) Payment initiater (Sagar patel ) \n\n(2) Approval - ( Paratan or Denare)',
    },
    expectedCommitments: [], // informational status update, no new commitment
  },
  {
    message: {
      MsgID: '3AB97AA2C7C2AC4A1A7D',
      ChatName: 'Nichol',
      SenderName: 'Nichol',
      Timestamp: '2026-04-16T20:23:17Z',
      Text: "1. Sure I can make march a full month. \n2. ⁠denare will lend you 24k, payable 2k a month over the next year. \n3. ⁠will you be cashflow positive each month? If not it's just going to be ballooning and it's never ending. If you have other debts, I suggest you (after some track record), take out a bank loan to pay things off lump sum and slowly pay back the loans, maintaining monthly positive cash flow",
    },
    expectedCommitments: [
      { who: 'Nichol', action: 'full month', type: 'waiting_on' },
      { who: 'Denare', action: 'lend', type: 'waiting_on' },
    ],
  },
];

const OWNER_NAMES = ['abhinav bansal', 'abbhinaav', 'abhi', 'abhinav'];

function isOwnerName(name: string): boolean {
  return OWNER_NAMES.some(n => name.toLowerCase().includes(n));
}

function matchCommitment(
  extracted: StructuredCommitment,
  expected: { who: string; action: string; type: string }
): boolean {
  const extractedWho = (extracted.who ?? '').toLowerCase();
  const expectedWho = expected.who.toLowerCase();

  // Owner name normalization: if expected is owner and extracted is any owner alias, match
  const whoMatch = extractedWho.includes(expectedWho) ||
    (isOwnerName(expectedWho) && isOwnerName(extractedWho));
  const actionMatch = extracted.owes_what?.toLowerCase().includes(expected.action.toLowerCase()) ?? false;
  // Type matching: extraction types (commitment/delegation/follow_up) map to status (waiting_on/owed_by_me)
  // so we match loosely here
  const typeMatch = extracted.type === expected.type ||
    (expected.type === 'owed_by_me' && ['commitment', 'delegation', 'follow_up'].includes(extracted.type)) ||
    (expected.type === 'waiting_on' && ['commitment', 'delegation', 'follow_up'].includes(extracted.type));
  return whoMatch && (actionMatch || typeMatch);
}

async function runValidation() {
  console.log('=== Action Brain E2E Live Validation ===\n');
  console.log(`Gold set: ${GOLD_SET.length} messages, ${GOLD_SET.reduce((n, g) => n + g.expectedCommitments.length, 0)} expected commitments\n`);

  let totalExpected = 0;
  let totalMatched = 0;
  let totalExtracted = 0;
  let totalFalsePositives = 0;
  let totalMissed = 0;
  const results: string[] = [];

  for (const entry of GOLD_SET) {
    const { message, expectedCommitments } = entry;

    try {
      const extracted = await extractCommitments([message], {
        ownerName: 'Abhinav Bansal',
        ownerAliases: ['Abbhinaav', 'Abhi', 'Abhinav'],
      });
      totalExtracted += extracted.length;
      totalExpected += expectedCommitments.length;

      // Match expected against extracted
      const matched = new Set<number>();
      const missedExpected: string[] = [];

      for (const exp of expectedCommitments) {
        let found = false;
        for (let i = 0; i < extracted.length; i++) {
          if (!matched.has(i) && matchCommitment(extracted[i], exp)) {
            matched.add(i);
            found = true;
            totalMatched++;
            break;
          }
        }
        if (!found) {
          missedExpected.push(`${exp.who}: ${exp.action} (${exp.type})`);
          totalMissed++;
        }
      }

      const fps = extracted.length - matched.size;
      totalFalsePositives += fps;

      const status = missedExpected.length === 0 && fps === 0 ? '✅' :
                     missedExpected.length === 0 ? '⚠️' : '❌';

      const line = `${status} [${message.SenderName}] "${message.Text.substring(0, 60)}..."`;
      console.log(line);
      console.log(`   Expected: ${expectedCommitments.length} | Extracted: ${extracted.length} | Matched: ${matched.size} | FP: ${fps}`);

      if (missedExpected.length > 0) {
        console.log(`   MISSED: ${missedExpected.join(', ')}`);
      }
      if (fps > 0) {
        const unexpectedItems = extracted.filter((_, i) => !matched.has(i));
        for (const u of unexpectedItems) {
          console.log(`   UNEXPECTED: ${u.who}: ${u.owes_what} (${u.type}, conf=${u.confidence})`);
        }
      }

      // Show all extractions for debugging
      for (const e of extracted) {
        console.log(`   → ${e.who} | ${e.owes_what} | ${e.type} | conf=${e.confidence} | src=${e.source_message_id}`);
      }
      console.log();

    } catch (err) {
      console.log(`❌ [${message.SenderName}] ERROR: ${err}`);
      totalMissed += expectedCommitments.length;
      totalExpected += expectedCommitments.length;
      console.log();
    }
  }

  // Summary
  console.log('=== SUMMARY ===');
  const recall = totalExpected > 0 ? totalMatched / totalExpected : 0;
  const precision = totalExtracted > 0 ? totalMatched / totalExtracted : 0;
  const f1 = precision + recall > 0 ? 2 * (precision * recall) / (precision + recall) : 0;

  console.log(`Total expected: ${totalExpected}`);
  console.log(`Total extracted: ${totalExtracted}`);
  console.log(`Total matched: ${totalMatched}`);
  console.log(`Total missed: ${totalMissed}`);
  console.log(`Total false positives: ${totalFalsePositives}`);
  console.log(`Recall: ${(recall * 100).toFixed(1)}%`);
  console.log(`Precision: ${(precision * 100).toFixed(1)}%`);
  console.log(`F1: ${(f1 * 100).toFixed(1)}%`);
  console.log(`\nTarget: 90% recall`);
  console.log(`Verdict: ${recall >= 0.9 ? '✅ PASS' : '❌ FAIL'}`);
}

runValidation().catch(console.error);
