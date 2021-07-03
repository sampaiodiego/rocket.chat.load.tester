import RocketChatClient from '@rocket.chat/sdk/clients/Rocketchat';
import fetch from 'node-fetch';

import * as prom from './prom';
import { getRoomId } from './utils';

global.fetch = fetch;

export const clients = [];

const logger = false || {
	debug: (...args) => true || console.log(args),
	info: (...args) => true || console.log(args),
	warning: (...args) => true || console.log(args),
	warn: (...args) => true || console.log(args),
	error: (...args) => { console.error(args)},
};

const {
	TRY_REGISTER = 'yes',
	SSL_ENABLED,
	NO_SUBSCRIBE,
} = process.env;

const useSsl = typeof SSL_ENABLED !== 'undefined' ? ['yes', 'true'].includes(SSL_ENABLED) : true;

const tryRegister = ['yes', 'true'].includes(TRY_REGISTER);

export async function connect(host, type) {
	const client = new RocketChatClient({
		logger,
		host,
		useSsl,
	});
	await client.connect();

	prom.connected.inc();

	const socket = await client.socket;

	await new Promise(async (resolve) => {
		switch (type) {
			case 'web':
				await socket.ddp.call('public-settings/get');
				await socket.ddp.call('permissions/get');

				// this is done to simulate web client
				await client.subscribe('meteor.loginServiceConfiguration');
				await client.subscribe('meteor_autoupdate_clientVersions');

				// await client.subscribeNotifyAll();
				await Promise.all([
					'updateEmojiCustom',
					'deleteEmojiCustom',
					'public-settings-changed'
				].map(event => client.subscribe('stream-notify-all', event, false)));
				break;

			case 'android':
			case 'ios':
				await Promise.all([
					client.get('settings.public'),
					client.get('settings.oauth'),
				]);
				break;
		}

		resolve();
	});

	return client;
}

const getLoginSubs = (type) => {
	const subs = [];

	if (type === 'web') {
		subs.push(['stream-notify-all', 'deleteCustomSound', {"useCollection":false,"args":[]}]);
		subs.push(['stream-notify-all', 'updateCustomSound', {"useCollection":false,"args":[]}]);
		subs.push(['stream-notify-all', 'public-settings-changed', {"useCollection":false,"args":[]}]);
		subs.push(['stream-notify-logged', 'user-status', {"useCollection":false,"args":[]}]);
		subs.push(['stream-notify-logged', 'permissions-changed', {"useCollection":false,"args":[]}]);

		subs.push(['stream-importers', 'progress', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'app/added', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'app/removed', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'app/updated', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'app/statusUpdate', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'app/settingUpdated', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'command/added', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'command/disabled', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'command/updated', {"useCollection":false,"args":[]}]);
		subs.push(['stream-apps', 'command/removed', {"useCollection":false,"args":[]}]);
	}

	return subs;
}

const getLoginMethods = (type) => {
	const methods = [];

	if (type === 'web') {
		methods.push(['listCustomSounds']);
		methods.push(['listEmojiCustom']);
		methods.push(['getUserRoles']);
		methods.push(['subscriptions/get']);
		methods.push(['rooms/get']);
		methods.push(['apps/is-enabled']);
		methods.push(['loadLocale', 'pt-BR']);
		// methods.push(['autoTranslate.getSupportedLanguages', 'en']);
	}

	return methods;
}

const defaultCredentials = {
	username: 'loadtest%s',
	password: 'pass%s',
	email: 'loadtest%s@loadtest.com',
};
export const setDefaultCredentials = ({ username, password, email }) => {
	if (username) {
		defaultCredentials.username = username;
	}
	if (password) {
		defaultCredentials.password = password;
	}
	if (email) {
		defaultCredentials.email = email;
	}
}

const getCredentials = (current) => {
	return {
		username: defaultCredentials.username.replace(/\%s/, current),
		password: defaultCredentials.password.replace(/\%s/, current),
		email: defaultCredentials.email.replace(/\%s/, current),
	};
}

export async function login(client, credentials, type, userCount) {
	const end = prom.login.startTimer();
	try {
		const user = await client.login(credentials);

		// do one by one as doing three at same time was hanging
		switch (type) {
			case 'web':
				// await client.subscribeLoggedNotify();
				await Promise.all([
					'Users:NameChanged',
					'Users:Deleted',
					'updateAvatar',
					'updateEmojiCustom',
					'deleteEmojiCustom',
					'roles-change',
					'permissions-changed'
				].map(event => client.subscribe('stream-notify-logged', event, false)));

				// await client.subscribeNotifyUser();
				await Promise.all([
					'message',
					'otr',
					'webrtc',
					'notification',
					'audioNotification',
					'rooms-changed',
					'subscriptions-changed'
				].map(event => client.subscribe('stream-notify-user', `${user.id}/${event}`, false)));

				if (!NO_SUBSCRIBE) {
					await client.subscribeUserData();
				} else if (NO_SUBSCRIBE === 'no-active') {
					await Promise.all([
						'roles',
						'webdavAccounts',
						'userData',
						// 'activeUsers'
					].map(stream => client.subscribe(stream, '')));
				}
				break;

			case 'android':
			case 'ios':
				await Promise.all([
					'rooms-changed',
					'subscriptions-changed'
				].map((stream) => client.subscribe('stream-notify-user', `${user.id}/${stream}`)));

				await Promise.all([
					'userData',
					'activeUsers',
				].map((stream) => client.subscribe(stream, '')));

				await Promise.all([
					client.get('me'),
					client.get('permissions'),
					client.get('settings.public'),
					client.get('subscriptions.get'),
					client.get('rooms.get'),
				]);
				break;
		}

		await Promise.all(getLoginSubs(type).map(([stream, ...params]) => client.subscribe(stream, ...params)));

		const socket = await client.socket;

		await Promise.all(getLoginMethods(type).map((params) => socket.ddp.call(...params)));

		client.loggedInInternal = true;
		client.userCount = userCount;

		end({ status: 'success' });
	} catch (e) {
		console.error('error during login', e);
		end({ status: 'error' });
		throw e;
	}
};

export async function register(client, { username, email, password }) {
	const end = prom.register.startTimer();
	try {
		await client.post('users.register', {
			username,
			email,
			pass: password,
			name: username
		});
		end({ status: 'success' });
	} catch (e) {
		console.error('error register', e);
		end({ status: 'error' });
	}
}

export async function typing(client, rid, typing) {
	return client.socket.then((socket) => socket.ddp.call('stream-notify-room', `${ rid }/typing`, client.username, typing));
}

export async function sendMessage(client, rid, msg) {
	await typing(client, rid, true);

	const end = prom.messages.startTimer();
	try {
		await client.sendMessage(msg, rid);
		end({ status: 'success' });
	} catch (e) {
		console.error('error sending message', { uid: client.userId, rid }, e);
		end({ status: 'error' });
	}

	await typing(client, rid, false);
}

export async function subscribeRoom(client, rid) {
	const end = prom.roomSubscribe.startTimer();
	try {
		// console.log('client.subscribeRoom', rid);
		await client.subscribeRoom(rid);

        // const topic = 'stream-notify-room';
        // const result = await Promise.all([
        //     client.subscribe('stream-room-messages', rid),
        //     // client.subscribe(topic, `${rid}/typing`),
        //     // client.subscribe(topic, `${rid}/deleteMessage`)
        // ]);

		// console.log('result ->', result);

		end({ status: 'success' });
	} catch (e) {
		console.error('error subscribing room', { uid: client.userId, rid }, e);
		end({ status: 'error' });
	}
}

export async function joinRoom(client, rid) {
	const end = prom.roomJoin.startTimer();
	try {
		await client.joinRoom({ rid });
		end({ status: 'success' });
	} catch (e) {
		console.error('error joining room', { uid: client.userId, rid }, e);
		end({ status: 'error' });
	}
}

export async function openRoom(client, rid, type, roomType = 'groups') {
	const end = prom.openRoom.startTimer();
	try {
		const socket = await client.socket;

		const calls = [
			subscribeRoom(client, rid),
		];

		switch (type) {
			case 'web':
				calls.push(socket.ddp.call('getRoomRoles', rid));
				calls.push(socket.ddp.call('loadHistory', rid, null, 50, new Date()));
				break;

			case 'android':
			case 'ios':
				calls.push(client.get('commands.list'));
				calls.push(client.get(`${ roomType }.members`, { roomId: rid }));
				calls.push(client.get(`${ roomType }.roles`, { roomId: rid }));
				calls.push(client.get(`${ roomType }.history`, { roomId: rid }));
				break;
		}

		await Promise.all(calls);

		if (type === 'web') {
			await socket.ddp.call('readMessages', rid);
		} else if (type === 'android' || type === 'ios') {
			await client.post('subscriptions.read', { rid });
		}

		end({ status: 'success' });
	} catch (e) {
		console.error('error open room', { uid: client.userId, rid }, e);
		end({ status: 'error' });
	}
}

export const loginOrRegister = async (client, credentials, type, userCount) => {
	try {
		await login(client, credentials, type, userCount);
	} catch (e) {
		console.log('error', e);
		if (!tryRegister) {
			return;
		}
		try {
			await register(client, credentials, type);

			await login(client, credentials, type, userCount);
		} catch (e) {
			console.error('could not login/register for', credentials, e);
		}
	}
}

export const doLoginBatch = async (current, total, step = 10, type) => {

	console.log('login batch', current, total, step);

	// Splice clients into chunks
	const clientsCopy = [...clients];
	const clientsChunks = [];
	while(clientsCopy.length) {
		clientsChunks.push(clientsCopy.splice(0, step));
	}
	
	// Process every chunk
	while(current < total)
	{
		for(const clientsToBatch of clientsChunks)
		{
			const batch = [];
			clientsToBatch.forEach(client => {
				const credentials = getCredentials(current);
				batch.push(loginOrRegister(client, credentials, type, current));
				current++;
			});
			await Promise.all(batch);
		}
	}

	console.log((current - 1), 'logged in');

}

export const doLogin = async (countInit, batchSize = 1, type = 'web') => {
	const total = clients.length;
	if (batchSize > 1) {
		return await doLoginBatch(countInit, countInit + total, batchSize, type);
	}

	let i = 0;
	while (i < total) {
		if (!clients[i]) {
			console.error(`client ${ i } not initiliazed`);
			continue;
		}
		if (clients[i].loggedInInternal) {
			i++;
			continue;
		}

		// console.log('login', i);

		const userCount = countInit + i;

		const credentials = getCredentials(userCount);

		await loginOrRegister(clients[i], credentials, type, userCount);

		i++;
	}
}

let msgCounter = 0;
const atAllInterval = 1000;
const atHereInterval = 400;

export let msgInterval;
export function sendRandomMessage({ rid, totalClients, period, time, msgPerSecond } = {}) {
	const total = totalClients || clients.length;

	if (!msgPerSecond) {
		return clearInterval(msgInterval);
	}

	const timeInterval = period !== 'custom' ? (1 / msgPerSecond / total) : time;

	if (msgInterval) {
		clearInterval(msgInterval);
	}

	const send = async () => {
		let chosenOne = Math.floor(Math.random() * total);

		while (!clients[chosenOne].loggedInInternal) {
			chosenOne = Math.floor(Math.random() * total);
		}

		msgCounter++;

		let mention = '';
		if (msgCounter % atAllInterval === 0) {
			mention = '@all ';
		} else if (msgCounter % atHereInterval === 0) {
			mention = '@here ';
		}

		try {
			sendMessage(clients[chosenOne], (rid || getRoomId(clients[chosenOne].userCount)), `${ mention }hello from ${ chosenOne }`);
		} catch (e) {
			console.error('error sending message', e);
		}
	};
	msgInterval = setInterval(send, timeInterval * 1000);
}
