import { delay } from '../lib/delay';
import * as prom from '../lib/prom';
import { Client } from './Client';

export class WebClient extends Client {
  async beforeLogin(): Promise<void> {
    await this.client.connect({});

    prom.connected.inc();

    await this.client.methodCall('public-settings/get');
    await this.client.methodCall('permissions/get');

    // this is done to simulate web client
    await this.client.subscribe('meteor.loginServiceConfiguration');
    await this.client.subscribe('meteor_autoupdate_clientVersions');

    // await client.subscribeNotifyAll();
    await Promise.all(
      ['updateEmojiCustom', 'deleteEmojiCustom', 'public-settings-changed'].map(
        (event) => this.client.subscribe('stream-notify-all', event, false)
      )
    );
  }

  async login(): Promise<void> {
    await this.beforeLogin();

    const end = prom.login.startTimer();

    const { credentials } = this;
    try {
      const user = await this.client.login(credentials);

      await this.client.subscribeLoggedNotify();
      await Promise.all(
        [
          'Users:NameChanged',
          'Users:Deleted',
          'updateAvatar',
          'updateEmojiCustom',
          'deleteEmojiCustom',
          'roles-change',
          'permissions-changed',
        ].map((event) =>
          this.client.subscribe('stream-notify-logged', event, false)
        )
      );

      // await client.subscribeNotifyUser();
      await Promise.all(
        [
          'message',
          'otr',
          'webrtc',
          'notification',
          'audioNotification',
          'rooms-changed',
          'subscriptions-changed',
        ].map((event) =>
          this.client.subscribe(
            'stream-notify-user',
            `${user.id}/${event}`,
            false
          )
        )
      );

      await Promise.all(
        this.getLoginSubs().map(([stream, ...params]) =>
          this.client.subscribe(stream, ...params)
        )
      );

      await Promise.all(
        this.getLoginMethods().map((params) =>
          this.client.methodCall(...params)
        )
      );

      // this.loggedInInternal = true;
      // this.userCount = userCount;

      end({ status: 'success' });
    } catch (e) {
      console.error('error during login', e, credentials);
      end({ status: 'error' });
      throw e;
    }
  }

  protected getLoginMethods(): [string, string?][] {
    const methods: [string, string?][] = [];
    methods.push(['listCustomSounds']);
    methods.push(['listEmojiCustom']);
    methods.push(['getUserRoles']);
    methods.push(['subscriptions/get']);
    methods.push(['rooms/get']);
    methods.push(['apps/is-enabled']);
    methods.push(['loadLocale', 'pt-BR']);
    // methods.push(['autoTranslate.getSupportedLanguages', 'en']);

    return methods;
  }

  protected getLoginSubs = (): [
    string,
    string,
    { useCollection: false; args: [] }
  ][] => {
    const subs: [string, string, { useCollection: false; args: [] }][] = [];
    subs.push([
      'stream-notify-all',
      'deleteCustomSound',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-notify-all',
      'updateCustomSound',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-notify-all',
      'public-settings-changed',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-notify-logged',
      'user-status',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-notify-logged',
      'permissions-changed',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-importers',
      'progress',
      { useCollection: false, args: [] },
    ]);
    subs.push(['stream-apps', 'app/added', { useCollection: false, args: [] }]);
    subs.push([
      'stream-apps',
      'app/removed',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-apps',
      'app/updated',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-apps',
      'app/statusUpdate',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-apps',
      'app/settingUpdated',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-apps',
      'command/added',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-apps',
      'command/disabled',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-apps',
      'command/updated',
      { useCollection: false, args: [] },
    ]);
    subs.push([
      'stream-apps',
      'command/removed',
      { useCollection: false, args: [] },
    ]);

    return subs;
  };

  async sendMessage(rid: string, msg: string): Promise<void> {
    await this.typing(rid, true);
    await delay(1000);
    const end = prom.messages.startTimer();
    try {
      await this.client.sendMessage(msg, rid);
      end({ status: 'success' });
    } catch (e) {
      console.error(
        'error sending message',
        { uid: this.client.userId, rid },
        e
      );
      end({ status: 'error' });
    }

    await this.typing(rid, false);
  }

  async typing(rid: string, typing: boolean): Promise<void> {
    this.client.methodCall(
      'stream-notify-room',
      `${rid}/typing`,
      this.client.username,
      typing
    );
  }

  async openRoom(rid = 'GENERAL'): Promise<void> {
    const end = prom.openRoom.startTimer();
    try {
      const calls: Promise<unknown>[] = [this.subscribeRoom(rid)];

      calls.push(this.client.methodCall('getRoomRoles', rid));
      calls.push(
        this.client.methodCall('loadHistory', rid, null, 50, new Date())
      );

      await Promise.all(calls);

      if (this.type === 'web') {
        // await this.client.methodCall('readMessages', rid);
      } else if (this.type === 'android' || this.type === 'ios') {
        await this.client.post('subscriptions.read', { rid });
      }

      end({ status: 'success' });
    } catch (e) {
      console.error('error open room', { uid: this.client.userId, rid }, e);
      end({ status: 'error' });
    }
  }

  async subscribeRoom(rid: string): Promise<void> {
    const end = prom.roomSubscribe.startTimer();
    try {
      await this.client.subscribeRoom(rid);

      const topic = 'stream-notify-room';
      await Promise.all([
        this.client.subscribe('stream-room-messages', rid),
        this.client.subscribe(topic, `${rid}/typing`),
        this.client.subscribe(topic, `${rid}/deleteMessage`),
      ]);

      end({ status: 'success' });
    } catch (e) {
      console.error(
        'error subscribing room',
        { uid: this.client.userId, rid },
        e
      );
      end({ status: 'error' });
    }
  }
}