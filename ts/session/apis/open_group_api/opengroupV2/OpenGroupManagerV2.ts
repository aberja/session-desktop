import { OpenGroupData, OpenGroupV2Room } from '../../../../data/opengroups';
import { ConversationModel } from '../../../../models/conversation';
import { getConversationController } from '../../../conversations';
import { allowOnlyOneAtATime } from '../../../utils/Promise';
import { getOpenGroupV2ConversationId } from '../utils/OpenGroupUtils';
import { OpenGroupRequestCommonType } from './ApiUtil';
import { OpenGroupServerPoller } from './OpenGroupServerPoller';

import _, { clone, isEqual } from 'lodash';
import autoBind from 'auto-bind';
import { ConversationTypeEnum } from '../../../../models/conversationAttributes';
import { openGroupV2GetRoomInfoViaOnionV4 } from '../sogsv3/sogsV3RoomInfos';

let instance: OpenGroupManagerV2 | undefined;

export const getOpenGroupManager = () => {
  if (!instance) {
    instance = new OpenGroupManagerV2();
  }
  return instance;
};

export class OpenGroupManagerV2 {
  public static readonly useV2OpenGroups = false;

  /**
   * The map of opengroup pollers, by serverUrl.
   * A single poller polls for every room on the specified serverUrl
   */
  private readonly pollers: Map<string, OpenGroupServerPoller> = new Map();
  private isPolling = false;

  constructor() {
    autoBind(this);
  }

  /**
   * When we get our configuration from the network, we might get a few times the same open group on two different messages.
   * If we don't do anything, we will join them multiple times.
   * Which will cause a lot of duplicate messages as they will be merged on a single conversation.
   *
   * To avoid this issue, we allow only a single join of a specific opengroup at a time.
   */
  public async attemptConnectionV2OneAtATime(
    serverUrl: string,
    roomId: string,
    publicKey: string
  ): Promise<ConversationModel | undefined> {
    const oneAtaTimeStr = `oneAtaTimeOpenGroupV2Join:${serverUrl}${roomId}`;
    return allowOnlyOneAtATime(oneAtaTimeStr, async () => {
      return this.attemptConnectionV2(serverUrl, roomId, publicKey);
    });
  }

  public async startPolling() {
    await allowOnlyOneAtATime('V2ManagerStartPolling', this.startPollingBouncy);
  }

  /**
   * This is not designed to be restarted for now. If you stop polling
   */
  public stopPolling() {
    if (!this.isPolling) {
      return;
    }
    // the stop call calls the abortController, which will effectively cancel the request right away,
    // or drop the result from it.
    this.pollers.forEach(poller => {
      poller.stop();
    });
    this.pollers.clear();

    this.isPolling = false;
  }

  public addRoomToPolledRooms(roomInfos: Array<OpenGroupRequestCommonType>) {
    const grouped = _.groupBy(roomInfos, r => r.serverUrl);
    const groupedArray = Object.values(grouped);

    for (const groupedRooms of groupedArray) {
      const groupedRoomsServerUrl = groupedRooms[0].serverUrl;
      const poller = this.pollers.get(groupedRoomsServerUrl);
      if (!poller) {
        const uniqGroupedRooms = _.uniqBy(groupedRooms, r => r.roomId);
        this.pollers.set(groupedRoomsServerUrl, new OpenGroupServerPoller(uniqGroupedRooms));
      } else {
        // this won't do a thing if the room is already polled for
        roomInfos.forEach(poller.addRoomToPoll);
      }
    }
  }

  public removeRoomFromPolledRooms(roomInfos: OpenGroupRequestCommonType) {
    const poller = this.pollers.get(roomInfos.serverUrl);
    if (!poller) {
      return;
    }
    // this won't do a thing if the room is already polled for
    poller.removeRoomFromPoll(roomInfos);
    if (poller.getPolledRoomsCount() === 0) {
      this.pollers.delete(roomInfos.serverUrl);
      // this poller is not needed anymore, kill it
      poller.stop();
    }
  }

  /**
   * This function is private because we want to make sure it only runs once at a time.
   */
  private async startPollingBouncy() {
    if (this.isPolling) {
      return;
    }
    const allConvos = await OpenGroupData.getAllOpenGroupV2Conversations();

    let allRoomInfos = OpenGroupData.getAllV2OpenGroupRoomsMap();

    // this is time for some cleanup!
    // We consider the conversations are our source-of-truth,
    // so if there is a roomInfo without an associated convo, we remove it
    if (allRoomInfos) {
      await Promise.all(
        [...allRoomInfos.values()].map(async infos => {
          try {
            const roomConvoId = getOpenGroupV2ConversationId(infos.serverUrl, infos.roomId);
            if (!allConvos.get(roomConvoId)) {
              // remove the roomInfos locally for this open group room
              await OpenGroupData.removeV2OpenGroupRoom(roomConvoId);
              getOpenGroupManager().removeRoomFromPolledRooms(infos);
              // no need to remove it from the ConversationController, the convo is already not there
            }
          } catch (e) {
            window?.log?.warn('cleanup roomInfos error', e);
          }
        })
      );
    }
    // refresh our roomInfos list
    allRoomInfos = OpenGroupData.getAllV2OpenGroupRoomsMap();
    if (allRoomInfos) {
      this.addRoomToPolledRooms([...allRoomInfos.values()]);
    }

    this.isPolling = true;
  }

  /**
   *
   * @param serverUrl with protocol, hostname and port included
   */
  private async attemptConnectionV2(
    serverUrl: string,
    roomId: string,
    serverPublicKey: string
  ): Promise<ConversationModel | undefined> {
    let conversationId = getOpenGroupV2ConversationId(serverUrl, roomId);

    if (getConversationController().get(conversationId)) {
      // Url incorrect or server not compatible
      throw new Error(window.i18n('publicChatExists'));
    }

    // here, the convo does not exist. Make sure the db is clean too
    await OpenGroupData.removeV2OpenGroupRoom(conversationId);

    try {
      const room: OpenGroupV2Room = {
        serverUrl,
        roomId,
        conversationId,
        serverPublicKey,
      };
      const updatedRoom = clone(room);
      // save the pubkey to the db right now, the request for room Info
      // will need it and access it from the db
      await OpenGroupData.saveV2OpenGroupRoom(room);

      const roomInfos = await openGroupV2GetRoomInfoViaOnionV4({
        serverPubkey: serverPublicKey,
        serverUrl,
        roomId,
      });

      if (!roomInfos || !roomInfos.id) {
        throw new Error('Invalid open group roomInfo result');
      }
      updatedRoom.roomId = roomInfos.id;
      conversationId = getOpenGroupV2ConversationId(serverUrl, roomInfos.id);
      updatedRoom.conversationId = conversationId;
      if (!isEqual(room, updatedRoom)) {
        await OpenGroupData.removeV2OpenGroupRoom(conversationId);
        await OpenGroupData.saveV2OpenGroupRoom(updatedRoom);
      }

      const conversation = await getConversationController().getOrCreateAndWait(
        conversationId,
        ConversationTypeEnum.GROUP
      );
      updatedRoom.imageID = roomInfos.imageId || undefined;
      updatedRoom.roomName = roomInfos.name || undefined;
      updatedRoom.capabilities = roomInfos.capabilities;
      await OpenGroupData.saveV2OpenGroupRoom(updatedRoom);

      // mark active so it's not in the contacts list but in the conversation list
      // mark isApproved as this is a public chat
      conversation.set({
        active_at: Date.now(),
        displayNameInProfile: updatedRoom.roomName,
        isApproved: true,
        didApproveMe: true,
        isTrustedForAttachmentDownload: true, // we always trust attachments when sent to an opengroup
      });
      await conversation.commit();

      // start polling this room
      this.addRoomToPolledRooms([updatedRoom]);

      return conversation;
    } catch (e) {
      window?.log?.warn('Failed to join open group v2', e.message);
      await OpenGroupData.removeV2OpenGroupRoom(conversationId);
      // throw new Error(window.i18n('connectToServerFail'));
      return undefined;
    }
  }
}
