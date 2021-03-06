import uuidv4 from 'uuid/v4';

import {
	createUsers,
	createUserToken,
	expectHTTPErrorCode,
	getTestClient,
	getTestClientForUser,
	getServerTestClient,
	sleep,
	createEventWaiter,
} from './utils';
import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

const expect = chai.expect;

chai.use(chaiAsPromised);

if (process.env.NODE_ENV !== 'production') {
	require('longjohn');
}

const Promise = require('bluebird');
Promise.config({
	longStackTraces: true,
	warnings: {
		wForgottenReturn: false,
	},
});

describe('query by frozen', function() {
	let client;
	let channel;
	let user = uuidv4();
	before(async function() {
		await createUsers([user]);
		client = await getTestClientForUser(user);
		channel = client.channel('messaging', uuidv4(), {
			members: [user],
		});
		await channel.create();
	});

	it('frozen:false should return 1 active channels', async function() {
		const resp = await client.queryChannels({
			members: { $in: [user] },
			frozen: false,
		});
		expect(resp.length).to.be.equal(1);
		expect(resp[0].cid).to.be.equal(channel.cid);
	});

	it('frozen:true should return 0 results', async function() {
		const resp = await client.queryChannels({
			members: { $in: [user] },
			frozen: true,
		});
		expect(resp.length).to.be.equal(0);
	});

	it('mark the channel as frozen and search frozen:true should return 1 result', async function() {
		await channel.update({ frozen: true });
		const resp = await client.queryChannels({
			members: { $in: [user] },
			frozen: true,
		});
		expect(resp.length).to.be.equal(1);
		expect(resp[0].cid).to.be.equal(channel.cid);
	});

	it('send messages on a frozen channel should fail', async function() {
		const resp = await channel.sendMessage({ text: 'hi' });
		expect(resp.message.text).to.be.equal(
			'Sorry, this channel has been frozen by the admin',
		);
	});

	it('remove the frozen property and search frozen:false should return 1 result', async function() {
		await channel.update({ frozen: false });
		const resp = await client.queryChannels({
			members: { $in: [user] },
			frozen: false,
		});
		expect(resp.length).to.be.equal(1);
		expect(resp[0].cid).to.be.equal(channel.cid);
	});
});

describe('Channels - Constructor', function() {
	const client = getServerTestClient();

	it('canonical form', function(done) {
		const channel = client.channel('messaging', '123', { cool: true });
		expect(channel.cid).to.eql('messaging:123');
		expect(channel.id).to.eql('123');
		expect(channel.data).to.eql({ cool: true });
		done();
	});

	it('default options', function(done) {
		const channel = client.channel('messaging', '123');
		expect(channel.cid).to.eql('messaging:123');
		expect(channel.id).to.eql('123');
		done();
	});

	it('null ID no options', function(done) {
		const channel = client.channel('messaging', null);
		expect(channel.id).to.eq(undefined);
		done();
	});

	it('undefined ID no options', function(done) {
		const channel = client.channel('messaging', undefined);
		expect(channel.id).to.eql(undefined);
		expect(channel.data).to.eql({});
		done();
	});

	it('short version with options', function(done) {
		const channel = client.channel('messaging', { members: ['tommaso', 'thierry'] });
		expect(channel.data).to.eql({ members: ['tommaso', 'thierry'] });
		expect(channel.id).to.eql(undefined);
		done();
	});

	it('null ID with options', function(done) {
		const channel = client.channel('messaging', null, {
			members: ['tommaso', 'thierry'],
		});
		expect(channel.data).to.eql({ members: ['tommaso', 'thierry'] });
		expect(channel.id).to.eql(undefined);
		done();
	});

	it('empty ID  with options', function(done) {
		const channel = client.channel('messaging', '', {
			members: ['tommaso', 'thierry'],
		});
		expect(channel.data).to.eql({ members: ['tommaso', 'thierry'] });
		expect(channel.id).to.eql(undefined);
		done();
	});

	it('empty ID  with options', function(done) {
		const channel = client.channel('messaging', undefined, {
			members: ['tommaso', 'thierry'],
		});
		expect(channel.data).to.eql({ members: ['tommaso', 'thierry'] });
		expect(channel.id).to.eql(undefined);
		done();
	});
});

describe('Channels - Create', function() {
	const johnID = `john-${uuidv4()}`;

	it('john creates a channel with members', async function() {
		const c = await getTestClientForUser(johnID);
		const channelId = uuidv4();
		const johnChannel = c.channel('messaging', channelId, {
			color: 'green',
			members: [johnID],
		});
		const response = await johnChannel.create();
		expect(response.channel.color).to.equal('green');
		const cid = `messaging:${channelId}`;
		expect(response.channel.cid).to.equal(cid);
		expect(response.channel.members).to.equal(undefined);
		expect(response.members.length).to.equal(1);

		const queryResponse = await c.queryChannels({ cid }, undefined, {
			state: true,
			presence: true,
		});
	});
});

describe('Channels - members', function() {
	const tommasoID = `tommaso-${uuidv4()}`;
	const thierryID = `thierry-${uuidv4()}`;

	const channelGroup = 'messaging';
	const channelId = `test-channels-${uuidv4()}`;
	const tommasoToken = createUserToken(tommasoID);
	const thierryToken = createUserToken(thierryID);

	const tommasoClient = getTestClient();
	const thierryClient = getTestClient();

	let tommasoChannel, thierryChannel;
	const message = { text: 'nice little chat API' };

	const tommasoChannelEventQueue = [];
	const thierryChannelEventQueue = [];
	let tommasoPromise;
	let thierryPromise1;
	let thierryPromise2;

	let tommasoMessageID;

	before(async () => {
		await tommasoClient.setUser({ id: tommasoID }, tommasoToken);
		await thierryClient.setUser({ id: thierryID }, thierryToken);
	});

	it('tommaso creates a new channel', async function() {
		tommasoChannel = tommasoClient.channel(channelGroup, channelId);
		tommasoPromise = new Promise(resolve => {
			tommasoChannel.on(event => {
				tommasoChannelEventQueue.push(event);
				if (tommasoChannelEventQueue.length === 4) {
					resolve();
				}
			});
		});
		await tommasoChannel.watch();
	});

	it(`tommaso tries to create a channel that's too large`, async function() {
		await expectHTTPErrorCode(
			413,
			tommasoClient
				.channel(channelGroup, `big-boy-${uuidv4()}`, {
					stuff: 'x'.repeat(6 * 1024),
				})
				.create(),
		);
	});

	it(`tommaso tries to create a channel with a reserved character`, async function() {
		await expectHTTPErrorCode(
			400,
			tommasoClient.channel(channelGroup, `!${channelId}`).watch(),
		);
	});

	it('thierry tries to join the channel', async function() {
		await expectHTTPErrorCode(
			403,
			thierryClient.channel(channelGroup, channelId).watch(),
		);
	});

	it('tommaso adds thierry as channel member', async function() {
		await tommasoChannel.addMembers([thierryID]);
	});

	it('thierry tries to join the channel', async function() {
		thierryChannel = thierryClient.channel(channelGroup, channelId);
		thierryPromise2 = new Promise(resolve2 => {
			thierryPromise1 = new Promise(resolve1 => {
				thierryChannel.on(event => {
					thierryChannelEventQueue.push(event);
					if (thierryChannelEventQueue.length === 2) {
						resolve1();
					}
					if (thierryChannelEventQueue.length === 4) {
						resolve2();
					}
				});
			});
		});
		await thierryChannel.watch();
	});

	it('tommaso gets an event about Thierry joining', async function() {
		await tommasoPromise;
		let event = tommasoChannelEventQueue.pop();
		expect(event.type).to.eql('user.watching.start');
		expect(event.user.id).to.eql(thierryID);

		event = tommasoChannelEventQueue.pop();
		expect(event.type).to.eql('channel.updated');
		event = tommasoChannelEventQueue.pop();
		expect(event.type).to.eql('member.added');
	});

	it('tommaso posts a message', async function() {
		await tommasoChannel.sendMessage(message);
	});

	it('thierry gets the new message from tommaso', async function() {
		await thierryPromise1;
		const event = thierryChannelEventQueue.pop();
		expect(event.type).to.eql('message.new');
		tommasoMessageID = event.message.id;
	});

	it('thierry tries to update the channel description', async function() {
		await expectHTTPErrorCode(
			403,
			thierryChannel.update({ description: 'taking over this channel now!' }),
		);
	});

	it('tommaso updates the channel description', async function() {
		await tommasoChannel.update({ description: 'taking over this channel now!' });
	});

	it('tommaso updates his own message', async function() {
		await tommasoClient.updateMessage({
			id: tommasoMessageID,
			text: 'I mean, awesome chat',
		});
	});

	it('thierry tries to update tommaso message', async function() {
		await expectHTTPErrorCode(
			403,
			thierryClient.updateMessage({
				id: tommasoMessageID,
				text: 'I mean, awesome chat',
			}),
		);
	});

	it('thierry mutes himself', async function() {
		const response = await thierryChannel.sendMessage({
			text: `/mute @${thierryID}`,
		});
		expect(response.message.type).to.eql('error');
	});

	it('thierry gets promoted', async function() {
		await getTestClient(true).updateUser({ id: thierryID, role: 'admin' });
	});

	it('correct member count', async function() {
		const members = [uuidv4(), uuidv4()];
		await createUsers(members);

		const channel = tommasoClient.channel('messaging', uuidv4(), { members });
		await channel.create();

		const newMembers = [uuidv4(), uuidv4()];
		await createUsers(newMembers);

		await channel.addMembers([newMembers[0]]);
		await channel.addMembers([newMembers[1]]);

		const resp = await channel.query();
		expect(resp.members.length).to.be.equal(4);
		expect(resp.channel.member_count).to.be.equal(4);
	});

	describe('Channel members', function() {
		const channelId = `test-member-cache-${uuidv4()}`;
		const initialMembers = [tommasoID, thierryID];
		const newMembers = [uuidv4(), uuidv4()];

		let channel;

		before(async function() {
			await createUsers(newMembers);
			channel = tommasoClient.channel('messaging', channelId);
		});

		describe('When creating channel', function() {
			before(async function() {
				await channel.create();
			});

			it('returns empty channel members list', async function() {
				const resp = await channel.watch();

				expect(resp.members.length).to.be.equal(0);
			});
		});

		describe('When adding members to new channel', function() {
			before(async function() {
				await channel.addMembers(initialMembers);
			});

			it('returns channel members', async function() {
				const resp = await channel.watch();

				expect(resp.members.length).to.be.equal(initialMembers.length);
				expect(resp.members.map(m => m.user.id)).to.have.members(initialMembers);
			});
		});

		describe('When adding members to existing channel', function() {
			before(async function() {
				await channel.addMembers(newMembers);
			});

			it('returns existing members and new ones', async function() {
				const resp = await channel.watch();
				expect(resp.members.length).to.be.equal(4);
				expect(resp.members.map(m => m.user.id)).to.have.members(
					initialMembers.concat(newMembers),
				);
			});
		});

		describe('When removing members', function() {
			before(async function() {
				await channel.removeMembers(newMembers);
			});

			it('returns members without deleted', async function() {
				const resp = await channel.watch();
				expect(resp.members.length).to.be.equal(2);
				expect(resp.members.map(m => m.user.id)).to.have.members(initialMembers);
			});
		});
	});

	it('channel messages and last_message_at are correctly returned', async function() {
		const unique = uuidv4();
		const newMembers = ['member1', 'member2'];
		await createUsers(newMembers);
		const channelId = `channel-messages-cache-${unique}`;
		const channel2Id = `channel-messages-cache2-${unique}`;
		const channel = tommasoClient.channel('messaging', channelId, {
			unique: unique,
		});
		await channel.create();
		const channel2 = tommasoClient.channel('messaging', channel2Id, {
			unique: unique,
		});
		await channel2.create();

		const channel1Messages = [];
		const channel2Messages = [];
		for (let i = 0; i < 10; i++) {
			const msg = channel.sendMessage({ text: 'new message' });
			const op2 = channel.update({ unique, color: 'blue' });
			const op3 = channel.addMembers(newMembers);
			const msg2 = await channel2.sendMessage({ text: 'new message 2' });
			const results = await Promise.all([msg, op2, op3]);

			if (i % 2 === 0) {
				let last_message = results[0].message.created_at;
				if (msg2.message.created_at > last_message) {
					last_message = msg2.message.created_at;
				}
				const channels = await tommasoClient.queryChannels(
					{ unique: unique },
					{ last_message_at: -1 },
					{ state: true },
				);
				expect(channels.length).to.be.equal(2);
				expect(channels[0].data.last_message_at).to.be.equal(last_message);
			}
			channel1Messages.push(results[0].message);
			channel2Messages.push(msg2.message);
		}

		const stateChannel1 = await channel.watch();
		const stateChannel2 = await channel2.watch();

		const expectedChannel1Messages = channel1Messages;
		const expectedChannel2Messages = channel2Messages;

		expect(stateChannel1.messages.length).to.be.equal(
			expectedChannel1Messages.length,
		);
		expect(stateChannel2.messages.length).to.be.equal(
			expectedChannel2Messages.length,
		);

		for (let i = 0; i < stateChannel1.messages.length; i++) {
			expect(stateChannel1.messages[i].id).to.be.equal(
				expectedChannel1Messages[i].id,
			);
		}
		for (let i = 0; i < stateChannel2.messages.length; i++) {
			expect(stateChannel2.messages[i].id).to.be.equal(
				expectedChannel2Messages[i].id,
			);
		}
	});
});

describe('Channels - Members are update correctly', function() {
	const channelId = uuidv4();
	const cid = `messaging:${channelId}`;
	const johnID = `john-${uuidv4()}`;
	const members = [
		{
			id: `member1-${uuidv4()}`,
			role: 'user',
			counter: 0,
		},
		{
			id: `member2-${uuidv4()}`,
			role: 'user',
			counter: 0,
		},
		{
			id: `member3-${uuidv4()}`,
			role: 'user',
			counter: 0,
		},
	];

	const runWithOtherOperations = async function(op) {
		const op2 = channel.update({ color: 'green' }, { text: 'got new message!' });
		const op3 = channel.sendMessage({ text: 'new message' });
		const op4 = channel.sendMessage({ text: 'new message' });
		const results = await Promise.all([op, op2, op3, op4]);
		return results[0];
	};

	let channel;
	let client;
	before(async function() {
		client = await getTestClientForUser(johnID);
		await createUsers(
			members.map(function(member) {
				return member.id;
			}),
		);

		channel = client.channel('messaging', channelId, {
			color: 'green',
			members: [members[0].id],
		});
		const response = await channel.create();
		expect(response.channel.color).to.equal('green');
		expect(response.channel.cid).to.equal(cid);
		expect(response.channel.members).to.equal(undefined);
		expect(response.members.length).to.equal(1);
	});

	it('channel state must be updated after removing a member', async function() {
		const resp = await runWithOtherOperations(channel.removeMembers([members[0].id]));
		expect(resp.members.length).to.be.equal(0);
		const channelState = await channel.watch();
		expect(channelState.members.length).to.be.equal(0);
	});

	it('channel state must be updated after adding a member', async function() {
		const resp = await runWithOtherOperations(channel.addMembers([members[0].id]));
		expect(resp.members.length).to.be.equal(1);
		const channelState = await channel.watch();
		expect(channelState.members.length).to.be.equal(1);
		expect(channelState.members[0].user.id).to.be.equal(members[0].id);
	});

	it('channel state must be updated after adding multiple members', async function() {
		const resp = await runWithOtherOperations(
			channel.addMembers([members[0].id, members[1].id, members[2].id]),
		);
		expect(resp.members.length).to.be.equal(3);
		const channelState = await channel.watch();
		expect(channelState.members.length).to.be.equal(3);
		const memberIDs = channelState.members.map(m => m.user.id);
		expect(memberIDs).to.deep.members(members.map(m => m.id));
	});

	it('channel state must be updated after removing multiple members', async function() {
		const resp = await runWithOtherOperations(
			channel.removeMembers([members[0].id, members[1].id, members[2].id]),
		);
		expect(resp.members.length).to.be.equal(0);
		const channelState = await channel.watch();
		expect(channelState.members.length).to.be.equal(0);
	});
});

describe('Channels - Distinct channels', function() {
	const tommasoID = `tommaso-${uuidv4()}`;
	const thierryID = `thierry-${uuidv4()}`;
	const newMember = `member-${uuidv4()}`;

	const channelGroup = 'messaging';
	const tommasoToken = createUserToken(tommasoID);
	const thierryToken = createUserToken(thierryID);

	const tommasoClient = getTestClient();
	const thierryClient = getTestClient();
	let distinctChannel;

	const unique = uuidv4();
	before(async () => {
		await tommasoClient.setUser({ id: tommasoID }, tommasoToken);
		await thierryClient.setUser({ id: thierryID }, thierryToken);
		await createUsers([newMember]);
	});

	it('create a distinct channel without specifying members should fail', async function() {
		const channel = thierryClient.channel(channelGroup, '');
		await expectHTTPErrorCode(
			400,
			channel.create(),
			'StreamChat error code 4: GetOrCreateChannel failed with error: "When using member based IDs specify at least 2 members"',
		);
	});

	it('create a distinct channel with only one member should fail', async function() {
		const channel = thierryClient.channel(channelGroup, '', {
			members: [tommasoID],
		});
		await expectHTTPErrorCode(
			400,
			channel.create(),
			'StreamChat error code 4: GetOrCreateChannel failed with error: "When using member based IDs specify at least 2 members"',
		);
	});

	it('create a distinct channel with 2 members should succeed', async function() {
		distinctChannel = thierryClient.channel(channelGroup, null, {
			members: [tommasoID, thierryID],
			unique,
		});
		await distinctChannel.create();
	});

	it('query previous created distinct channel', async function() {
		const channels = await thierryClient.queryChannels({
			members: [tommasoID, thierryID],
			unique,
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].data.unique).to.be.equal(unique);
	});

	it('adding members to distinct channel should fail', async function() {
		await expectHTTPErrorCode(
			400,
			distinctChannel.addMembers([newMember]),
			'StreamChat error code 4: UpdateChannel failed with error: "cannot add or remove members in a distinct channel, please create a new distinct channel with the desired members"',
		);
	});

	it('removing members from a distinct channel should fail', async function() {
		await expectHTTPErrorCode(
			400,
			distinctChannel.removeMembers([tommasoID]),
			'StreamChat error code 4: UpdateChannel failed with error: "cannot add or remove members in a distinct channel, please create a new distinct channel with the desired members"',
		);
	});
});

describe('Query Channels and sort by unread', function() {
	const channels = [];
	const tommaso = 'tommaso' + uuidv4();
	const thierry = 'thierry' + uuidv4();
	let tommasoClient;
	let thierryClient;
	before(async function() {
		thierryClient = await getTestClientForUser(thierry);
		await createUsers([tommaso, thierry]);
		const cidPrefix = uuidv4();
		for (let i = 3; i >= 0; i--) {
			let color;
			if (i % 2 == 0) {
				color = 'blue';
			} else {
				color = 'red';
			}
			const channel = thierryClient.channel('messaging', cidPrefix + i, { color });
			await channel.watch();
			await channel.addMembers([tommaso, thierry]);
			for (let j = 0; j < i + 1; j++) {
				await channel.sendMessage({ text: 'hi' + j });
			}
			channels.push(channel);
		}
	});

	it('sort by has_unread and last_message_at asc should work', async function() {
		tommasoClient = await getTestClientForUser(tommaso);
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ has_unread: 1, last_message_at: 1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[0].cid);
		expect(result[1].cid).to.be.equal(channels[1].cid);
		expect(result[2].cid).to.be.equal(channels[2].cid);
		expect(result[3].cid).to.be.equal(channels[3].cid);
	});

	it('sort by has_unread and last_message_at', async function() {
		tommasoClient = await getTestClientForUser(tommaso);
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ has_unread: 1, last_message_at: -1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[3].cid);
		expect(result[1].cid).to.be.equal(channels[2].cid);
		expect(result[2].cid).to.be.equal(channels[1].cid);
		expect(result[3].cid).to.be.equal(channels[0].cid);
	});

	it.skip('sort by unread_count asc', async function() {
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: 1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[3].cid);
		expect(result[1].cid).to.be.equal(channels[2].cid);
		expect(result[2].cid).to.be.equal(channels[1].cid);
		expect(result[3].cid).to.be.equal(channels[0].cid);
	});

	it('sort by unread_count desc', async function() {
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: -1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[0].cid);
		expect(result[1].cid).to.be.equal(channels[1].cid);
		expect(result[2].cid).to.be.equal(channels[2].cid);
		expect(result[3].cid).to.be.equal(channels[3].cid);
	});

	it.skip('zero the counts and sort by has_unread and last_message_at asc', async function() {
		tommasoClient = await getTestClientForUser(tommaso);
		await tommasoClient.markAllRead();
		tommasoClient = await getTestClientForUser(tommaso);
		expect(tommasoClient.health.me.total_unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ has_unread: 1, last_message_at: 1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[0].cid);
		expect(result[1].cid).to.be.equal(channels[1].cid);
		expect(result[2].cid).to.be.equal(channels[2].cid);
		expect(result[3].cid).to.be.equal(channels[3].cid);
	});

	it('zero the counts and sort by has_unread and last_message_at desc', async function() {
		tommasoClient = await getTestClientForUser(tommaso);
		await tommasoClient.markAllRead();
		tommasoClient = await getTestClientForUser(tommaso);
		expect(tommasoClient.health.me.total_unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);
		let result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ has_unread: 1, last_message_at: -1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[3].cid);
		expect(result[1].cid).to.be.equal(channels[2].cid);
		expect(result[2].cid).to.be.equal(channels[1].cid);
		expect(result[3].cid).to.be.equal(channels[0].cid);
	});

	it.skip('zero the counts and sort by unread_count and last_message_at asc', async function() {
		tommasoClient = await getTestClientForUser(tommaso);
		await tommasoClient.markAllRead();
		tommasoClient = await getTestClientForUser(tommaso);
		expect(tommasoClient.health.me.total_unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: 1, last_message_at: 1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[0].cid);
		expect(result[1].cid).to.be.equal(channels[1].cid);
		expect(result[2].cid).to.be.equal(channels[2].cid);
		expect(result[3].cid).to.be.equal(channels[3].cid);
	});

	it.skip('zero the counts and sort by unread_count and last_message_at desc', async function() {
		tommasoClient = await getTestClientForUser(tommaso);
		await tommasoClient.markAllRead();
		tommasoClient = await getTestClientForUser(tommaso);
		expect(tommasoClient.health.me.total_unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: 1, last_message_at: -1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[3].cid);
		expect(result[1].cid).to.be.equal(channels[2].cid);
		expect(result[2].cid).to.be.equal(channels[1].cid);
		expect(result[3].cid).to.be.equal(channels[0].cid);
	});

	it('test "grouping"', async function() {
		tommasoClient = await getTestClientForUser(tommaso);
		await channels[0].sendMessage({ text: 'hi' });
		await sleep(200);
		await channels[1].sendMessage({ text: 'hi' });
		let result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ has_unread: -1, last_message_at: -1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[1].cid);
		expect(result[1].cid).to.be.equal(channels[0].cid);
		expect(result[2].cid).to.be.equal(channels[3].cid);
		expect(result[3].cid).to.be.equal(channels[2].cid);

		result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: -1, last_message_at: 1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[0].cid);
		expect(result[1].cid).to.be.equal(channels[1].cid);
		expect(result[2].cid).to.be.equal(channels[2].cid);
		expect(result[3].cid).to.be.equal(channels[3].cid);

		/*result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: 1, last_message_at: -1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[3].cid);
		expect(result[1].cid).to.be.equal(channels[2].cid);
		expect(result[2].cid).to.be.equal(channels[1].cid);
		expect(result[3].cid).to.be.equal(channels[0].cid);

		result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: 1, last_message_at: 1 },
		);

		expect(result.length).to.be.equal(4);
		expect(result[0].cid).to.be.equal(channels[2].cid);
		expect(result[1].cid).to.be.equal(channels[3].cid);
		expect(result[2].cid).to.be.equal(channels[0].cid);
		expect(result[3].cid).to.be.equal(channels[1].cid);*/
	});

	it('limit results should work fine', async function() {
		await tommasoClient.markAllRead();
		tommasoClient = await getTestClientForUser(tommaso);
		expect(tommasoClient.health.me.total_unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);
		await channels[0].sendMessage({ text: 'hi' });
		await channels[1].sendMessage({ text: 'hi' });
		let result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: -1, last_message_at: -1 },
			{ limit: 1 },
		);

		expect(result.length).to.be.equal(1);
		expect(result[0].cid).to.be.equal(channels[1].cid);

		result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] } },
			{ unread_count: -1, last_message_at: 1 },
			{ limit: 1 },
		);

		expect(result.length).to.be.equal(1);
		expect(result[0].cid).to.be.equal(channels[0].cid);
	});

	it('unread count + custom query should work', async function() {
		await tommasoClient.markAllRead();
		tommasoClient = await getTestClientForUser(tommaso);
		expect(tommasoClient.health.me.total_unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);
		await channels[0].sendMessage({ text: 'hi' });
		await channels[1].sendMessage({ text: 'hi' });
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] }, color: 'blue' },
			{ unread_count: -1, last_message_at: -1 },
		);

		expect(result.length).to.be.equal(2);
		expect(result[0].cid).to.be.equal(channels[1].cid);
		expect(result[0].data.color).to.be.equal('blue');
		expect(result[1].data.color).to.be.equal('blue');
	});

	it('unread count + custom query with limit should work', async function() {
		await tommasoClient.markAllRead();
		tommasoClient = await getTestClientForUser(tommaso);
		expect(tommasoClient.health.me.total_unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);
		await channels[0].sendMessage({ text: 'hi' });
		await channels[1].sendMessage({ text: 'hi' });
		const result = await tommasoClient.queryChannels(
			{ members: { $in: [tommaso] }, color: 'blue' },
			{ unread_count: -1, last_message_at: -1 },
			{ limit: 1 },
		);
		expect(result.length).to.be.equal(1);
		expect(result[0].cid).to.be.equal(channels[1].cid);
		expect(result[0].data.color).to.be.equal('blue');
	});
});

describe('members and unread count', function() {
	let client1;
	let client2;

	const user1 = uuidv4();
	const user2 = uuidv4();

	const channelID = uuidv4();

	before(async function() {
		client1 = await getTestClientForUser(user1);
		await getTestClientForUser(user2);
		await client1
			.channel('messaging', channelID, { members: [user1, user2] })
			.create();
	});

	it('adding a member twice should not mark the channel as read', async function() {
		const channel = client1.channel('messaging', channelID);
		await channel.sendMessage({ text: 'hi 1' });
		await channel.addMembers([user2]);
		client2 = await getTestClientForUser(user2);
		expect(client2.health.me.total_unread_count).to.eq(1);
	});
});

describe('hard delete messages', function() {
	const channelID = uuidv4();
	const user = uuidv4();
	let client, ssclient;
	let channel;
	let firstMessage;
	let secondMeessage;
	let thirdMeessage;

	before(async function() {
		client = await getTestClientForUser(user);
		ssclient = await getTestClient(true);
		channel = client.channel('messaging', channelID);
		await channel.create();
	});

	it('send 3 messages to the channel', async function() {
		firstMessage = await channel.sendMessage({ text: 'hi 1' });
		secondMeessage = await channel.sendMessage({ text: 'hi 2' });
		thirdMeessage = await channel.sendMessage({ text: 'hi 3' });
	});

	it('hard delete messages is not allowed client side', function() {
		expect(client.deleteMessage(firstMessage.message.id, true)).to.be.rejectedWith(
			'StreamChat error code 4: DeleteMessage failed with error: "hard delete messages is only allowed with server side auth"',
		);
	});

	it('hard delete the second message should work and not update  channel.last_message_id', async function() {
		channel = ssclient.channel('messaging', channelID, { created_by_id: user });
		await channel.watch();
		expect(channel.data.last_message_at).to.be.equal(
			thirdMeessage.message.created_at,
		);

		const resp = await ssclient.deleteMessage(secondMeessage.message.id, true);
		expect(resp.message.deleted_at).to.not.be.undefined;
		expect(resp.message.type).to.be.equal('deleted');

		channel = ssclient.channel('messaging', channelID, { created_by_id: user });
		await channel.watch();
		expect(channel.data.last_message_at).to.be.equal(
			thirdMeessage.message.created_at,
		);
	});

	it('hard delete the third message should update the channel last_message_at', async function() {
		const resp = await ssclient.deleteMessage(thirdMeessage.message.id, true);
		expect(resp.message.deleted_at).to.not.be.undefined;
		expect(resp.message.type).to.be.equal('deleted');

		channel = ssclient.channel('messaging', channelID, { created_by_id: user });
		await channel.watch();
		expect(channel.data.last_message_at).to.be.equal(firstMessage.message.created_at);
	});

	it('hard delete the last message in the channel should clear channel messages and last_message_at', async function() {
		const resp = await ssclient.deleteMessage(firstMessage.message.id, true);
		expect(resp.message.deleted_at).to.not.be.undefined;
		expect(resp.message.type).to.be.equal('deleted');

		channel = ssclient.channel('messaging', channelID, { created_by_id: user });
		const channelResp = await channel.watch();
		expect(channelResp.channel.last_message_at).to.be.undefined;
		expect(channelResp.messages.length).to.be.equal(0);
	});

	it('messages with reactions are hard deleted properly', async function() {
		let channel = ssclient.channel('messaging', channelID, { created_by_id: user });
		await channel.watch();

		let resp = await channel.sendMessage({ text: 'hi', user_id: user });
		await channel.sendReaction(resp.message.id, { type: 'love' }, user);
		resp = await ssclient.deleteMessage(resp.message.id, true);
		expect(resp.message.deleted_at).to.not.be.undefined;

		channel = ssclient.channel('messaging', channelID, { created_by_id: user });
		const channelResp = await channel.watch();
		expect(channelResp.last_message_at).to.be.undefined;
		expect(channelResp.messages.length).to.be.equal(0);
	});

	it('query the channel should also return correct results', async function() {
		let channels = await ssclient.queryChannels({ cid: 'messaging:' + channelID });
		expect(channels.length).to.be.equal(1);
		const theChannel = channels[0];
		expect(theChannel.data.last_message_at).to.be.undefined;
	});

	it('validate channel.last_message_at correctly updated', async function() {
		let channels = await client.queryChannels({ cid: 'messaging:' + channelID });
		expect(channels.length).to.be.equal(1);
		const theChannel = channels[0];
		expect(theChannel.data.last_message_at).to.be.undefined;

		let messages = [];
		for (let i = 0; i < 10; i++) {
			messages.push(await theChannel.sendMessage({ text: 'hi' + i }));
		}

		for (let i = 9; i >= 0; i--) {
			await ssclient.deleteMessage(messages[i].message.id, true);
			channel = ssclient.channel('messaging', channelID, { created_by_id: user });
			const channelResp = await channel.watch();
			if (i == 0) {
				expect(channelResp.channel.last_message_at).to.be.be.undefined;
			} else {
				expect(channelResp.channel.last_message_at).to.be.equal(
					messages[i - 1].message.created_at,
				);
			}
		}
	});

	it('validate first channel message', async function() {
		let channels = await client.queryChannels({ cid: 'messaging:' + channelID });
		expect(channels.length).to.be.equal(1);
		const theChannel = channels[0];
		expect(theChannel.data.last_message_at).to.be.undefined;

		let messages = [];
		for (let i = 0; i < 10; i++) {
			messages.push(await theChannel.sendMessage({ text: 'hi' + i }));
		}

		for (let i = 0; i < 10; i++) {
			await ssclient.deleteMessage(messages[i].message.id, true);
			channel = ssclient.channel('messaging', channelID, { created_by_id: user });
			const channelResp = await channel.watch();
			//delete last message
			if (i === 9) {
				expect(channelResp.channel.last_message_at).to.be.be.undefined;
			} else {
				expect(channelResp.messages.length).to.be.equal(9 - i);
				expect(channelResp.messages[0].text).to.be.equal('hi' + (i + 1));
			}
		}
	});

	it('hard delete threads should work fine', async function() {
		let channels = await client.queryChannels({ cid: 'messaging:' + channelID });
		expect(channels.length).to.be.equal(1);
		const theChannel = channels[0];
		expect(theChannel.data.last_message_at).to.be.undefined;
		const parent = await theChannel.sendMessage({ text: 'the parent' });
		await theChannel.sendMessage({ text: 'the reply', parent_id: parent.message.id });
		await ssclient.deleteMessage(parent.message.id, true);

		const channels2 = await ssclient.queryChannels({ cid: 'messaging:' + channelID });
		expect(channels2.length).to.be.equal(1);
		const resp = await channels2[0].watch();
		expect(resp.last_message_at).to.be.undefined;
		expect(channels2[0].data.last_message_at).to.be.undefined;
	});
});

describe('query channels by field $exists', function() {
	const creator = uuidv4();
	const testID = uuidv4();
	let client;

	let channelCID = function(i) {
		return 'messaging:' + i + '-' + testID;
	};
	//create 10 channels, even index contains even custom field and odd index contains odd custom field
	before(async function() {
		await createUsers([creator]);
		client = await getTestClientForUser(creator);
		for (let i = 0; i < 10; i++) {
			let custom = {};
			custom['field' + i] = i;
			custom['testid'] = testID;
			if (i % 2 === 0) {
				custom['even'] = true;
			} else {
				custom['odd'] = true;
			}

			await client
				.channel('messaging', i + '-' + testID, {
					...custom,
				})
				.create();
		}
	});

	it('only boolean values are allowed in $exists', async function() {
		await expect(
			client.queryChannels({ testid: testID, even: { $exists: [] } }),
		).to.be.rejectedWith(
			'QueryChannels failed with error: "$exists operator only support boolean values"',
		);
	});

	it('query $exists true on a custom field should work', async function() {
		const resp = await client.queryChannels({
			testid: testID,
			even: { $exists: true },
		});
		expect(resp.length).to.be.equal(5);
		expect(
			resp.map(c => {
				return c.cid;
			}),
		).to.be.eql([
			channelCID(8),
			channelCID(6),
			channelCID(4),
			channelCID(2),
			channelCID(0),
		]);
	});

	it('query $exists false on a custom field should work', async function() {
		const resp = await client.queryChannels({
			testid: testID,
			even: { $exists: false },
		});
		expect(resp.length).to.be.equal(5);
		expect(
			resp.map(c => {
				return c.cid;
			}),
		).to.be.eql([
			channelCID(9),
			channelCID(7),
			channelCID(5),
			channelCID(3),
			channelCID(1),
		]);
	});

	it('query $exists true on reserved field', async function() {
		const resp = await client.queryChannels({
			testid: testID,
			cid: { $exists: true },
		});
		expect(resp.length).to.be.equal(10);
		expect(
			resp.map(c => {
				return c.cid;
			}),
		).to.be.eql([
			channelCID(9),
			channelCID(8),
			channelCID(7),
			channelCID(6),
			channelCID(5),
			channelCID(4),
			channelCID(3),
			channelCID(2),
			channelCID(1),
			channelCID(0),
		]);
	});

	it('query $exists false on reserved field should return 0 results', async function() {
		const resp = await client.queryChannels({
			testid: testID,
			cid: { $exists: false },
		});
		expect(resp.length).to.be.equal(0);
	});

	it('combine multiple $exists should work', async function() {
		const resp = await client.queryChannels({
			testid: testID,
			$or: [{ even: { $exists: true } }, { odd: { $exists: true } }],
		});
		expect(resp.length).to.be.equal(10);
		expect(
			resp.map(c => {
				return c.cid;
			}),
		).to.be.eql([
			channelCID(9),
			channelCID(8),
			channelCID(7),
			channelCID(6),
			channelCID(5),
			channelCID(4),
			channelCID(3),
			channelCID(2),
			channelCID(1),
			channelCID(0),
		]);
	});
});

describe('query channels members $nin', function() {
	let creator = uuidv4();
	let membersIdS = [uuidv4(), uuidv4(), uuidv4(), uuidv4()];
	let client;

	before(async function() {
		await createUsers(membersIdS);
		await createUsers(creator);
		client = await getTestClientForUser(creator);
		for (let i = 0; i < membersIdS.length; i++) {
			const memberId = membersIdS[i];
			await client
				.channel('messaging', memberId, {
					members: [creator, memberId],
				})
				.create();
		}
	});

	it('query $in/$nin', async function() {
		const resp = await client.queryChannels({
			$and: [
				{ members: { $in: [creator] } },
				{ members: { $nin: [membersIdS[0]] } },
			],
		});

		//expect channel id membersIdS[0] to be excluded from result
		for (let i = 0; i < resp.length; i++) {
			expect(resp[i].id).not.be.equal(membersIdS[0]);
			expect(membersIdS.indexOf(resp[i].id)).not.be.equal(-1);
		}
	});
});

describe('Unread state for non members', function() {
	let client;
	const watcher = uuidv4();
	const otherUser = uuidv4();
	let otherUserClient;
	const emptyChan = uuidv4();
	const chanId = uuidv4();
	let chan;

	before(async function() {
		client = await getTestClientForUser(watcher);
		otherUserClient = await getTestClientForUser(otherUser);
		const c = otherUserClient.channel('livestream', emptyChan, {
			members: [otherUser],
		});
		await c.create();
		chan = otherUserClient.channel('livestream', chanId);
		await chan.create();
		await chan.sendMessage({ text: 'Test Message 1' });
		await chan.sendMessage({ text: 'Test Message 2' });
		await chan.sendMessage({ text: 'Test Message 3' });
	});

	it('connect to empty channel', async function() {
		const c = client.channel('livestream', emptyChan);
		await c.watch();
		const unreadCount = c.countUnread();
		expect(unreadCount).to.be.equal(0);
	});

	it('connect to a channel with 3 messages', async function() {
		const c = client.channel('livestream', chanId);
		await c.watch();
		const unreadCount = c.countUnread();
		expect(unreadCount).to.be.equal(0);
	});

	it('unread count should go up when new messages are received', async function() {
		const c = client.channel('livestream', chanId);
		await c.watch();
		const unreadCount = c.countUnread();
		expect(unreadCount).to.be.equal(0);
		const waiter = createEventWaiter(client, 'message.new');
		await chan.sendMessage({ text: 'Test Message 4' });
		await waiter;
		expect(c.countUnread()).to.be.equal(1);
	});
});

describe('Query channels using last_updated', function() {
	const CHANNELS_ORDER = [1, 2, 0];
	const NUM_OF_CHANNELS = CHANNELS_ORDER.length;
	const CHANGED_CHANNEL = 1;

	const creator = uuidv4();
	const channels = [];
	let client;
	const unique = uuidv4();
	before(async function() {
		client = await getTestClientForUser(creator);
		await createUsers([creator]);
		for (let i = 0; i < NUM_OF_CHANNELS; i++) {
			const channel = client.channel('messaging', 'channelme_' + uuidv4(), {
				unique,
			});
			await channel.create();
			channels.push(channel);
		}

		await channels[CHANGED_CHANNEL].sendMessage({ text: 'Test Message' });
	});

	it('with the parameter', async function() {
		const list = await client.queryChannels({ unique: unique });

		expect(list.length).equal(channels.length);
		for (let i = 0; i < NUM_OF_CHANNELS; i++) {
			expect(list[i].cid).equal(channels[CHANNELS_ORDER[i]].cid);
		}
	});

	it('without parameters', async function() {
		let list = await client.queryChannels({ unique: unique }, { last_updated: -1 });

		expect(list.length).equal(channels.length);
		for (let i = 0; i < NUM_OF_CHANNELS; i++) {
			expect(list[i].cid).equal(channels[CHANNELS_ORDER[i]].cid);
		}
	});

	it('filtering by the parameter', async function() {
		let list = await client.queryChannels({
			unique: unique,
			last_updated: channels[0].data.created_at,
		});

		expect(list.length).equal(1);
		expect(list[0].cid).equal(channels[0].cid);
	});
});

describe('Channels op $in with custom fields', function() {
	const user1 = uuidv4();
	const user2 = uuidv4();
	const channelId = uuidv4();
	const channelId2 = uuidv4();
	const unique = uuidv4(); //used to return consistent results in test
	let user1Client;
	before(async function() {
		await createUsers([user1, user2]);
		user1Client = await getTestClientForUser(user1);

		const channel = user1Client.channel('messaging', channelId, {
			members: [user1, user2],
			color: ['blue', 'red'],
			age: [30, 31],
			array: [[1], [2]],
			object: [{ a: 1 }, { b: 1 }],
			unique,
		});
		await channel.create();
		const channel2 = user1Client.channel('messaging', channelId2, {
			members: [user1, user2],
			customField: [6],
			unique,
		});
		await channel2.create();
	});

	it('query $in on custom string field subset', async function() {
		const channels = await user1Client.queryChannels({
			unique: unique,
			color: { $in: ['red'] },
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom string $or custom $in int', async function() {
		const channels = await user1Client.queryChannels({
			$or: [{ color: { $in: ['red'] } }, { customField: { $in: [6] } }],
			unique: unique,
		});
		expect(channels.length).to.be.equal(2);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId2}`);
		expect(channels[1].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom string field full set out of order', async function() {
		const channels = await user1Client.queryChannels({
			color: { $in: ['red', 'blue'] },
			unique: unique,
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom int field subset', async function() {
		const channels = await user1Client.queryChannels({
			unique: unique,
			age: { $in: [30] },
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom int field full set out of order', async function() {
		const channels = await user1Client.queryChannels({
			unique: unique,
			age: { $in: [31, 30] },
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom array field subset', async function() {
		const channels = await user1Client.queryChannels({
			unique: unique,
			array: { $in: [[1]] },
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom array field full set out of order', async function() {
		const channels = await user1Client.queryChannels({
			unique: unique,
			array: { $in: [[2], [1]] },
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom object field subset', async function() {
		const channels = await user1Client.queryChannels({
			unique: unique,
			object: { $in: [{ a: 1 }] },
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom object field full set out of order', async function() {
		const channels = await user1Client.queryChannels({
			unique: unique,
			object: { $in: [{ a: 1 }, { b: 1 }] },
		});
		expect(channels.length).to.be.equal(1);
		expect(channels[0].cid).to.be.equal(`messaging:${channelId}`);
	});

	it('query $in on custom field (wrong value types)', async function() {
		const channels = await user1Client.queryChannels({
			unique: unique,
			object: { $in: [3] },
		});
		expect(channels.length).to.be.equal(0);
	});
});

describe('$ne operator', function() {
	let client;
	let channels = [];
	let unique = uuidv4();
	let creator = uuidv4();

	before(async function() {
		client = await getTestClientForUser(creator);
		for (let i = 1; i < 5; i++) {
			let c = client.channel('messaging', uuidv4(), {
				unique,
				number: i,
				string: i.toString(),
				object: { key: i },
				array: [i],
			});
			await c.create();
			channels.push(c);
		}
	});

	it('query $ne on reserved fields', async function() {
		let response = await client.queryChannels({
			unique: unique,
			id: { $ne: channels[0].id },
		});
		expect(response.length).to.be.equal(3);
		expect(
			response.findIndex(function(c) {
				return c.id === channels[0].id;
			}),
		).to.be.equal(-1);
	});

	it('query $ne with invalid type on reserved fields', async function() {
		await expectHTTPErrorCode(
			400,
			client.queryChannels({ unique: unique, id: { $ne: 1 } }),
			'StreamChat error code 4: QueryChannels failed with error: "field `id` contains type number. expecting string"',
		);
	});

	it('query $ne on custom int fields', async function() {
		let response = await client.queryChannels({
			unique: unique,
			number: { $ne: channels[0].data.number },
		});
		expect(response.length).to.be.equal(3);
		expect(
			response.findIndex(function(c) {
				return c.id === channels[0].id;
			}),
		).to.be.equal(-1);
	});

	it('query $ne on custom string fields', async function() {
		let response = await client.queryChannels({
			unique: unique,
			string: { $ne: channels[0].data.string },
		});
		expect(response.length).to.be.equal(3);
		expect(
			response.findIndex(function(c) {
				return c.id === channels[0].id;
			}),
		).to.be.equal(-1);
	});

	it('query $ne on custom object fields', async function() {
		let response = await client.queryChannels({
			unique: unique,
			object: { $ne: channels[0].data.object },
		});
		expect(response.length).to.be.equal(3);
		expect(
			response.findIndex(function(c) {
				return c.id === channels[0].id;
			}),
		).to.be.equal(-1);
	});

	it('query $ne on custom array fields', async function() {
		let response = await client.queryChannels({
			unique: unique,
			array: { $ne: channels[0].data.array },
		});
		expect(response.length).to.be.equal(3);
		expect(
			response.findIndex(function(c) {
				return c.id === channels[0].id;
			}),
		).to.be.equal(-1);
	});
});

describe('query by $autocomplete operator on channels.name', function() {
	let client;
	let channel;
	let user = uuidv4();
	before(async function() {
		await createUsers([user]);
		client = await getTestClientForUser(user);
		channel = client.channel('messaging', uuidv4(), {
			members: [user],
			name: uuidv4(),
		});
		await channel.create();
	});

	it('return 1 result', async function() {
		const resp = await client.queryChannels({
			members: [user],
			name: {
				$autocomplete: channel.data.name.substring(0, 8),
			},
		});
		expect(resp.length).to.be.equal(1);
		expect(resp[0].cid).to.be.equal(channel.cid);
	});
});

describe('unread counts on hard delete messages', function() {
	let channel;
	let client;
	let ssclient;
	const tommaso = uuidv4();
	const thierry = uuidv4();
	const nick = uuidv4();
	const messages = [];
	before(async function() {
		await createUsers([tommaso, thierry, nick]);
		client = await getTestClientForUser(tommaso);
		ssclient = await getTestClient(true);

		channel = client.channel('messaging', uuidv4(), {
			members: [tommaso, thierry, nick],
		});
		await channel.create();
	});

	it('tommaso sends 3 messages', async function() {
		for (let i = 0; i < 3; i++) {
			messages.push(await channel.sendMessage({ text: 'hi' }));
		}
	});

	it('tommaso deletes the 1st message', async function() {
		await ssclient.deleteMessage(messages[0].message.id, true);
	});

	it('validates unread counts for all the users', async function() {
		let tommasoClient = await getTestClientForUser(tommaso);
		// expect 0 conts since tommaso is the sender
		expect(tommasoClient.health.me.unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);

		let thierryClient = await getTestClientForUser(thierry);
		// expect 2 counts since we deleted the first message
		expect(thierryClient.health.me.unread_count).to.be.equal(2);
		expect(thierryClient.health.me.unread_channels).to.be.equal(1);

		let nickClient = await getTestClientForUser(nick);
		// expect 2 counts since  we deleted the first message
		expect(nickClient.health.me.unread_count).to.be.equal(2);
		expect(nickClient.health.me.unread_channels).to.be.equal(1);
	});

	it('nick and thierry mark the channel as read', async function() {
		let nickClient = await getTestClientForUser(nick);
		let nickChannel = nickClient.channel(channel.type, channel.id);
		await nickChannel.watch();
		await nickChannel.markRead();

		let thierryClient = await getTestClientForUser(thierry);
		let thierryChannel = thierryClient.channel(channel.type, channel.id);
		await thierryChannel.watch();
		await thierryChannel.markRead();
	});

	it('tommaso hard delete the remaining messages', async function() {
		await ssclient.deleteMessage(messages[1].message.id, true);
		await ssclient.deleteMessage(messages[2].message.id, true);
	});

	it('unread counts should be zero for all the users', async function() {
		let tommasoClient = await getTestClientForUser(tommaso);
		// expect 0 conts since tommaso is the sender
		expect(tommasoClient.health.me.unread_count).to.be.equal(0);
		expect(tommasoClient.health.me.unread_channels).to.be.equal(0);

		let thierryClient = await getTestClientForUser(thierry);
		// expect 2 counts since we deleted the first message
		expect(thierryClient.health.me.unread_count).to.be.equal(0);
		expect(thierryClient.health.me.unread_channels).to.be.equal(0);

		let nickClient = await getTestClientForUser(nick);
		// expect 2 counts since we deleted the first message
		expect(nickClient.health.me.unread_count).to.be.equal(0);
		expect(nickClient.health.me.unread_channels).to.be.equal(0);
	});
});

describe('channel message search', function() {
	let authClient;
	before(async () => {
		authClient = await getTestClientForUser(uuidv4());
	});

	it('Basic Query (old format)', async function() {
		const channelId = uuidv4();
		// add a very special message
		const channel = authClient.channel('messaging', channelId);
		await channel.create();
		const keyword = 'supercalifragilisticexpialidocious';
		await channel.sendMessage({ text: `words ${keyword} what?` });
		await channel.sendMessage({ text: `great movie because of ${keyword}` });

		const filters = { type: 'messaging' };
		const response = await channel.search('supercalifragilisticexpialidocious', {
			limit: 2,
			offset: 0,
		});
		expect(response.results.length).to.equal(2);
		expect(response.results[0].message.text).to.contain(
			'supercalifragilisticexpialidocious',
		);
	});

	it('invalid query argument type should return an error', async function() {
		const unique = uuidv4();
		const channel = authClient.channel('messaging', uuidv4(), {
			unique,
		});
		await channel.create();
		try {
			await channel.search(1);
		} catch (e) {
			expect(e.message).to.be.equal('Invalid type number for query parameter');
		}
	});

	it('query message custom fields', async function() {
		const unique = uuidv4();
		const channel = authClient.channel('messaging', uuidv4(), {
			unique,
		});
		await channel.create();
		await channel.sendMessage({ text: 'hi', unique });

		const messageFilters = { unique };
		const response = await channel.search(messageFilters);
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.unique).to.equal(unique);
	});

	it('search by message type', async function() {
		const unique = uuidv4();
		const channel = authClient.channel('messaging', uuidv4(), {
			unique,
		});
		await channel.create();
		const regular = await channel.sendMessage({ text: 'regular' });
		const reply = await channel.sendMessage({
			text: 'reply',
			parent_id: regular.message.id,
		});

		let response = await channel.search({ type: 'regular' });
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.id).to.equal(regular.message.id);

		response = await channel.search({ type: 'reply' });
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.id).to.equal(reply.message.id);

		response = await channel.search({ type: { $in: ['reply', 'regular'] } });
		expect(response.results.length).to.equal(2);
	});

	it('query message text and custom field', async function() {
		const unique = uuidv4();
		const channel = authClient.channel('messaging', uuidv4(), {
			unique,
		});
		await channel.create();
		await channel.sendMessage({ text: 'hi', unique });
		await channel.sendMessage({ text: 'hi' });

		const messageFilters = { text: 'hi', unique: unique };
		const response = await channel.search(messageFilters);
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.unique).to.equal(unique);
	});

	it('query messages with attachments', async function() {
		const unique = uuidv4();
		const channel = authClient.channel('messaging', uuidv4(), {
			unique,
		});
		await channel.create();
		const attachments = [
			{
				type: 'hashtag',
				name: 'awesome',
				awesome: true,
			},
		];
		await channel.sendMessage({ text: 'hi', unique });
		await channel.sendMessage({ text: 'hi', attachments });

		const messageFilters = { attachments: { $exists: true } };
		const response = await channel.search(messageFilters);
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.unique).to.be.undefined;
	});

	it('basic Query using $q syntax', async function() {
		// add a very special message
		const channel = authClient.channel('messaging', uuidv4());
		await channel.create();
		const keyword = 'supercalifragilisticexpialidocious';
		await channel.sendMessage({ text: `words ${keyword} what?` });
		await channel.sendMessage({ text: `great movie because of ${keyword}` });

		const response = await channel.search(
			{ text: { $q: 'supercalifragilisticexpialidocious' } },
			{ limit: 2, offset: 0 },
		);
		expect(response.results.length).to.equal(2);
		expect(response.results[0].message.text).to.contain(
			'supercalifragilisticexpialidocious',
		);
	});

	it('query by message id', async function() {
		// add a very special messsage
		const channel = authClient.channel('messaging', uuidv4());
		await channel.create();
		const smResp = await channel.sendMessage({ text: 'awesome response' });

		const response = await channel.search(
			{ id: smResp.message.id },
			{ limit: 2, offset: 0 },
		);
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.id).to.equal(smResp.message.id);
	});

	it('query by message parent_id', async function() {
		const channel = authClient.channel('messaging', uuidv4());
		await channel.create();
		const smResp = await channel.sendMessage({ text: 'awesome response' });
		const reply = await channel.sendMessage({
			text: 'awesome response reply',
			parent_id: smResp.message.id,
		});

		const response = await channel.search(
			{ parent_id: smResp.message.id },
			{ limit: 2, offset: 0 },
		);
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.id).to.equal(reply.message.id);
	});

	it('query parent_id $exists + custom field', async function() {
		const channel = authClient.channel('messaging', uuidv4());
		await channel.create();
		const smResp = await channel.sendMessage({ text: 'awesome response' });
		const reply = await channel.sendMessage({
			text: 'awesome response reply',
			parent_id: smResp.message.id,
			unique: uuidv4(),
		});

		const response = await channel.search(
			{ parent_id: { $exists: true }, unique: reply.message.unique },
			{ limit: 2, offset: 0 },
		);
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.id).to.equal(reply.message.id);
	});

	it('query by message reply count', async function() {
		const channel = authClient.channel('messaging', uuidv4());
		await channel.create();
		const smResp = await channel.sendMessage({ text: 'awesome response' });
		const reply = await channel.sendMessage({
			text: 'awesome response reply',
			parent_id: smResp.message.id,
		});

		const response = await channel.search(
			{ reply_count: 1 },
			{ limit: 2, offset: 0 },
		);
		expect(response.results.length).to.equal(1);
		expect(response.results[0].message.id).to.equal(smResp.message.id);
	});
});

describe('search on deleted channels', function() {
	let user = uuidv4();
	let channelId = uuidv4();
	let channel;
	let client;
	before(async function() {
		client = await getTestClientForUser(user);
		channel = client.channel('messaging', channelId, {
			members: [user],
		});
		await channel.create();
	});

	it('add some messages to the channel', async function() {
		for (let i = 0; i < 5; i++) {
			await channel.sendMessage({
				text: `supercalifragilisticexpialidocious ${i}`,
			});
		}
	});

	it('search by text', async function() {
		let resp = await channel.search('supercalifragilisticexpialidocious');
		expect(resp.results.length).to.be.equal(5);
	});

	it('delete and recreate the channel', async function() {
		await channel.delete();
		channel = client.channel('messaging', channelId, {
			members: [user],
		});
		await channel.create();
	});

	it('search on previously deleted chanel', async function() {
		let resp = await channel.search('supercalifragilisticexpialidocious');
		expect(resp.results.length).to.be.equal(0);
	});
});

describe('pagination with invalid offset', function() {
	let channel;
	let client;
	let user = uuidv4();
	before(async function() {
		client = await getTestClientForUser(user);
		channel = client.channel('messaging', uuidv4());
		await channel.create();

		for (let i = 0; i < 30; i++) {
			const m = await channel.sendMessage({ text: i.toString() });
		}
	});
	it('offset > than total channel messages', async function() {
		const result = await channel.query({ messages: { limit: 10, offset: 35 } });
		expect(result.messages.length).to.be.equal(0);
	});
});
