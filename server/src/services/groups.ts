import { one, type Queryable } from '../db.js';
import { segmentWhere, type Segment } from './campaigns.js';

// Ready-made member groups for the CRM. Each one is a saved audience: it updates itself, can be
// browsed in Members, messaged through Campaigns and downloaded. The choice of groups follows the
// retention research write-up (head start, near-reward nudges, light and lapsing buyers, referrals).
export interface Group {
  id: string;
  name: string;
  description: string;
  why: string;
  icon: string;
  segment: Omit<Segment, 'optInOnly'>;
  // A suggested campaign for the group, used to pre-fill the Campaigns form.
  idea: { name: string; message: string };
}

export const GROUPS: Group[] = [
  {
    id: 'new',
    name: 'New this week',
    description: 'Joined in the last 7 days.',
    why: 'A warm welcome while the card is new.',
    icon: 'heart',
    segment: { type: 'new', days: 7 },
    idea: { name: 'Welcome to the club', message: 'Thanks for joining! Your welcome treat is waiting on your card.' },
  },
  {
    id: 'joined_no_visit',
    name: 'Joined, never came back',
    description: 'Joined over 7 days ago and has not bought anything yet.',
    why: 'Light buyers respond most to a nudge.',
    icon: 'gift',
    segment: { type: 'joined_no_visit', days: 7 },
    idea: { name: 'Your free donut is waiting', message: 'Your welcome treat is still on your card. Pop in before it expires!' },
  },
  {
    id: 'one_visit',
    name: 'One visit only',
    description: 'Came once, more than 14 days ago.',
    why: 'The second visit is the one that builds a habit.',
    icon: 'receipt',
    segment: { type: 'one_visit', days: 14 },
    idea: { name: 'Come back for round two', message: 'Good to see you last time! Your next stamp is waiting. See you soon?' },
  },
  {
    id: 'near_reward',
    name: 'Almost there',
    description: '1 or 2 stamps away from the reward.',
    why: 'People speed up as they get close to a reward.',
    icon: 'star',
    segment: { type: 'near_reward', within: 2 },
    idea: { name: 'So close!', message: 'You are nearly at your free reward. One or two more visits and it is yours.' },
  },
  {
    id: 'reward_waiting',
    name: 'Reward waiting',
    description: 'Has an unused voucher that expires within 7 days.',
    why: 'Redeeming a reward brings people back again.',
    icon: 'ticket',
    segment: { type: 'reward_waiting', days: 7 },
    idea: { name: 'Don’t forget your treat', message: 'You have a reward on your card that expires soon. Come and enjoy it!' },
  },
  {
    id: 'regulars',
    name: 'Regulars',
    description: '3 or more visits in the last 60 days.',
    why: 'Thank them with recognition, not discounts.',
    icon: 'donut',
    segment: { type: 'regulars', days: 60 },
    idea: { name: 'Thank you for being a regular', message: 'You are one of our favourite faces. Here is a little thank-you treat on us.' },
  },
  {
    id: 'top_spenders',
    name: 'Top spenders',
    description: 'The top 10% of members by money spent.',
    why: 'Your most valuable customers deserve a personal touch.',
    icon: 'trophy',
    segment: { type: 'top_spenders' },
    idea: { name: 'Members-only tasting', message: 'As one of our best customers, you are invited to try our new flavour first.' },
  },
  {
    id: 'at_risk',
    name: 'At risk',
    description: 'Regulars (3+ visits) not seen for 30 to 60 days.',
    why: 'Catch good customers before they drift away.',
    icon: 'bell',
    segment: { type: 'at_risk', days: 30 },
    idea: { name: 'We miss you', message: 'It has been a little while! Come by this week and we will add a bonus stamp.' },
  },
  {
    id: 'lapsed',
    name: 'Lapsed',
    description: 'No visit for 60 days or more.',
    why: 'One win-back offer, then leave them be.',
    icon: 'history',
    segment: { type: 'inactive', days: 60 },
    idea: { name: 'It has been a while', message: 'We have new flavours since your last visit. Here is a treat to welcome you back.' },
  },
  {
    id: 'birthday',
    name: 'Birthday this month',
    description: 'Birthday falls in the current month.',
    why: 'A surprise treat feels personal.',
    icon: 'cake',
    segment: { type: 'birthday_month' },
    idea: { name: 'Happy birthday month!', message: 'It is your birthday month! Come celebrate with a donut on us.' },
  },
  {
    id: 'referrers',
    name: 'Referrers',
    description: 'Brought at least one friend.',
    why: 'Referred customers are worth more and stay longer.',
    icon: 'users',
    segment: { type: 'referrers' },
    idea: { name: 'Thanks for spreading the word', message: 'Thank you for bringing friends along. Share your code again for more treats.' },
  },
];

export const groupById = (id: string) => GROUPS.find((g) => g.id === id);

/** The segment for a group: everyone in it when browsing, only opted-in members when messaging. */
export const groupSegment = (g: Group, optInOnly = false): Segment => ({ ...g.segment, optInOnly }) as Segment;

/** Every group with its size and how many in it can be sent marketing. */
export async function groupSizes(q: Queryable) {
  const params: unknown[] = [];
  const cols = GROUPS.map((g, i) => {
    const where = segmentWhere(groupSegment(g), params);
    return `count(*) FILTER (WHERE ${where})::int AS m${i}, count(*) FILTER (WHERE (${where}) AND c.marketing_opt_in)::int AS r${i}`;
  });
  const row = (await one<Record<string, number>>(q, `SELECT ${cols.join(', ')} FROM customers c JOIN cards k ON k.customer_id = c.id`, params))!;
  return GROUPS.map((g, i) => ({ ...g, members: row[`m${i}`], reachable: row[`r${i}`] }));
}

/** The ids of the groups one member belongs to. */
export async function groupsOf(q: Queryable, customerId: string): Promise<string[]> {
  const params: unknown[] = [customerId];
  const cols = GROUPS.map((g, i) => `(${segmentWhere(groupSegment(g), params)}) AS g${i}`);
  const row = await one<Record<string, boolean>>(
    q,
    `SELECT ${cols.join(', ')} FROM customers c JOIN cards k ON k.customer_id = c.id WHERE c.id = $1`,
    params,
  );
  return row ? GROUPS.filter((_, i) => row[`g${i}`]).map((g) => g.id) : [];
}
