import type {
  BaseMetadata,
  BaseUserMeta,
  Client,
  ThreadData,
} from "@liveblocks/client";
import type {
  CacheState,
  CacheStore,
  ClientOptions,
  DM,
  DU,
  OpaqueClient,
  PrivateClientApi,
} from "@liveblocks/core";
import {
  assert,
  createClient,
  kInternal,
  makePoller,
  memoizeOnSuccess,
  raise,
  shallow,
} from "@liveblocks/core";
import { nanoid } from "nanoid";
import type { PropsWithChildren } from "react";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";
import { useSyncExternalStore } from "use-sync-external-store/shim/index.js";
import { useSyncExternalStoreWithSelector } from "use-sync-external-store/shim/with-selector.js";

import { selectedInboxNotifications } from "./comments/lib/selected-inbox-notifications";
import { autoRetry } from "./lib/retry-error";
import { useInitial, useInitialUnlessFunction } from "./lib/use-initial";
import { use } from "./lib/use-polyfill";
import type {
  InboxNotificationsState,
  LiveblocksContextBundle,
  RoomInfoState,
  RoomInfoStateSuccess,
  SharedContextBundle,
  UnreadInboxNotificationsCountState,
  UserState,
  UserStateSuccess,
} from "./types";

/**
 * Raw access to the React context where the LiveblocksProvider stores the
 * current client. Exposed for advanced use cases only.
 *
 * @private This is a private/advanced API. Do not rely on it.
 */
export const ClientContext = createContext<OpaqueClient | null>(null);

function missingUserError(userId: string) {
  return new Error(`resolveUsers didn't return anything for user '${userId}'`);
}

function missingRoomInfoError(roomId: string) {
  return new Error(
    `resolveRoomsInfo didn't return anything for room '${roomId}'`
  );
}

const _extras = new WeakMap<
  OpaqueClient,
  ReturnType<typeof makeExtrasForClient>
>();
const _bundles = new WeakMap<
  OpaqueClient,
  LiveblocksContextBundle<BaseUserMeta, BaseMetadata>
>();

export const POLLING_INTERVAL = 60 * 1000; // 1 minute
export const INBOX_NOTIFICATIONS_QUERY = "INBOX_NOTIFICATIONS";

function selectorFor_useInboxNotifications(
  state: CacheState<BaseMetadata>
): InboxNotificationsState {
  const query = state.queries[INBOX_NOTIFICATIONS_QUERY];

  if (query === undefined || query.isLoading) {
    return {
      isLoading: true,
    };
  }

  if (query.error !== undefined) {
    return {
      error: query.error,
      isLoading: false,
    };
  }

  return {
    inboxNotifications: selectedInboxNotifications(state),
    isLoading: false,
  };
}

function selectUnreadInboxNotificationsCount(state: CacheState<BaseMetadata>) {
  let count = 0;

  for (const notification of selectedInboxNotifications(state)) {
    if (
      notification.readAt === null ||
      notification.readAt < notification.notifiedAt
    ) {
      count++;
    }
  }

  return count;
}

function selectorFor_useUnreadInboxNotificationsCount(
  state: CacheState<BaseMetadata>
): UnreadInboxNotificationsCountState {
  const query = state.queries[INBOX_NOTIFICATIONS_QUERY];

  if (query === undefined || query.isLoading) {
    return {
      isLoading: true,
    };
  }

  if (query.error !== undefined) {
    return {
      error: query.error,
      isLoading: false,
    };
  }

  return {
    isLoading: false,
    count: selectUnreadInboxNotificationsCount(state),
  };
}

function getOrCreateContextBundle<
  U extends BaseUserMeta,
  M extends BaseMetadata,
>(client: OpaqueClient): LiveblocksContextBundle<U, M> {
  let bundle = _bundles.get(client);
  if (!bundle) {
    bundle = makeLiveblocksContextBundle(client);
    _bundles.set(client, bundle);
  }
  return bundle as LiveblocksContextBundle<U, M>;
}

// TODO: Likely a better / more clear name for this helper will arise. I'll
// rename this later. All of these are implementation details to support inbox
// notifications on a per-client basis.
function getExtrasForClient<M extends BaseMetadata>(client: OpaqueClient) {
  let extras = _extras.get(client);
  if (!extras) {
    extras = makeExtrasForClient(client);
    _extras.set(client, extras);
  }

  return extras as unknown as Omit<typeof extras, "store"> & {
    store: CacheStore<M>;
  };
}

function makeExtrasForClient<U extends BaseUserMeta, M extends BaseMetadata>(
  client: OpaqueClient
) {
  const internals = client[kInternal] as PrivateClientApi<U, M>;
  const store = internals.cacheStore;
  const notifications = internals.notifications;

  let lastRequestedAt: Date | undefined;

  /**
   * Performs one network fetch, and updates the store and last requested at
   * date if successful. If unsuccessful, will throw.
   */
  async function updateInboxNotifications() {
    const since =
      lastRequestedAt !== undefined ? { since: lastRequestedAt } : undefined;

    const result = await notifications.getInboxNotifications(since);

    store.updateThreadsAndNotifications(
      result.threads,
      result.inboxNotifications,
      result.deletedThreads,
      result.deletedInboxNotifications,
      INBOX_NOTIFICATIONS_QUERY
    );

    /**
     * We set the `lastRequestedAt` to the timestamp returned by the current request if:
     * 1. The `lastRequestedAt` has not been set
     * OR
     * 2. The current `lastRequestedAt` is older than the timestamp returned by the current request
     */
    if (
      lastRequestedAt === undefined ||
      lastRequestedAt < result.meta.requestedAt
    ) {
      lastRequestedAt = result.meta.requestedAt;
    }
  }

  let pollerSubscribers = 0;
  const poller = makePoller(async () => {
    return waitUntilInboxNotificationsLoaded()
      .then(updateInboxNotifications)
      .catch(() => {
        // When polling, we don't want to throw errors, ever
        // XXX Maybe issue console warnings here though?
      });
  });

  /**
   * Will trigger an initial fetch of inbox notifications if this hasn't
   * already happened. Will resolve once there is initial data. Will retry
   * a few times automatically in case fetching fails, with incremental backoff
   * delays. Will throw eventually only if all retries fail.
   */
  const waitUntilInboxNotificationsLoaded = memoizeOnSuccess(async () => {
    store.setQueryState(INBOX_NOTIFICATIONS_QUERY, {
      isLoading: true,
    });

    try {
      await autoRetry(
        () => updateInboxNotifications(),
        5,
        // XXX: Previously we did 40000, 80000 here, but... do we really wait
        // until over a minute? Seems too long to me. Maybe instead we want to
        // try a bit more often, and with a bit less waiting time?
        // XXX: Proposal: change the array below to [5000, 5000, 10000, 10000, 15000, 15000] (= total timeout of 1 minute)
        [5000, 10000, 20000, 40000, 80000]
      );
    } catch (err) {
      // Store the error in the cache as a side-effect, for non-Suspense
      store.setQueryState(INBOX_NOTIFICATIONS_QUERY, {
        isLoading: false,
        error: err as Error,
      });

      // Rethrow it for Suspense, where this promise must fail
      throw err;
    }
  });

  /**
   * Enables polling for inbox notifications when the component mounts. Stops
   * polling on unmount.
   *
   * Safe to be called multiple times from different components. The first
   * component to mount starts the polling. The last component to unmount stops
   * the polling.
   */
  function useEnableInboxNotificationsPolling() {
    useEffect(() => {
      // Increment
      pollerSubscribers++;
      poller.start(POLLING_INTERVAL);

      return () => {
        // Decrement
        if (pollerSubscribers <= 0) {
          console.warn(
            `Internal unexpected behavior. Cannot decrease subscriber count for query "${INBOX_NOTIFICATIONS_QUERY}"`
          );
          return;
        }

        pollerSubscribers--;
        if (pollerSubscribers <= 0) {
          poller.stop();
        }
      };
    }, []);
  }

  return {
    store,
    notifications,
    useEnableInboxNotificationsPolling,
    waitUntilInboxNotificationsLoaded,
  };
}

function makeLiveblocksContextBundle<
  U extends BaseUserMeta,
  M extends BaseMetadata,
>(client: Client<U>): LiveblocksContextBundle<U, M> {
  // Bind all hooks to the current client instance
  const useInboxNotificationThread = (inboxNotificationId: string) =>
    useInboxNotificationThread_withClient<M>(client, inboxNotificationId);

  const useMarkInboxNotificationAsRead = () =>
    useMarkInboxNotificationAsRead_withClient(client);

  const useMarkAllInboxNotificationsAsRead = () =>
    useMarkAllInboxNotificationsAsRead_withClient(client);

  // NOTE: This version of the LiveblocksProvider does _not_ take any props.
  // This is because we already have a client bound to it.
  function LiveblocksProvider(props: PropsWithChildren) {
    useEnsureNoLiveblocksProvider();
    return (
      <ClientContext.Provider value={client}>
        {props.children}
      </ClientContext.Provider>
    );
  }

  const shared = createSharedContext<U>(client);

  const bundle: LiveblocksContextBundle<U, M> = {
    LiveblocksProvider,

    useInboxNotifications: () => useInboxNotifications_withClient(client),
    useUnreadInboxNotificationsCount: () =>
      useUnreadInboxNotificationsCount_withClient(client),

    useMarkInboxNotificationAsRead,
    useMarkAllInboxNotificationsAsRead,

    useInboxNotificationThread,

    ...shared.classic,

    suspense: {
      LiveblocksProvider,

      useInboxNotifications: () =>
        useInboxNotificationsSuspense_withClient(client),
      useUnreadInboxNotificationsCount: () =>
        useUnreadInboxNotificationsCountSuspense_withClient(client),

      useMarkInboxNotificationAsRead,
      useMarkAllInboxNotificationsAsRead,

      useInboxNotificationThread,

      ...shared.suspense,
    },
  };
  return bundle;
}

function useInboxNotifications_withClient(client: OpaqueClient) {
  const { store, useEnableInboxNotificationsPolling } =
    getExtrasForClient(client);

  useEnableInboxNotificationsPolling();
  return useSyncExternalStoreWithSelector(
    store.subscribe,
    store.get,
    store.get,
    selectorFor_useInboxNotifications,
    shallow
  );
}

function useInboxNotificationsSuspense_withClient(client: OpaqueClient) {
  const { waitUntilInboxNotificationsLoaded } = getExtrasForClient(client);

  // Suspend until there are at least some inbox notifications
  use(waitUntilInboxNotificationsLoaded());

  // We're in a Suspense world here, and as such, the useInboxNotifications()
  // hook is expected to only return success results when we're here.
  const result = useInboxNotifications_withClient(client);
  assert(!result.error, "Did not expect error");
  assert(!result.isLoading, "Did not expect loading");
  return result;
}

function useUnreadInboxNotificationsCount_withClient(client: OpaqueClient) {
  const { store, useEnableInboxNotificationsPolling } =
    getExtrasForClient(client);

  useEnableInboxNotificationsPolling();
  return useSyncExternalStoreWithSelector(
    store.subscribe,
    store.get,
    store.get,
    selectorFor_useUnreadInboxNotificationsCount,
    shallow
  );
}

function useUnreadInboxNotificationsCountSuspense_withClient(
  client: OpaqueClient
) {
  const { waitUntilInboxNotificationsLoaded } = getExtrasForClient(client);

  // Suspend until there are at least some inbox notifications
  use(waitUntilInboxNotificationsLoaded());

  const result = useUnreadInboxNotificationsCount_withClient(client);
  assert(!result.isLoading, "Did not expect loading");
  assert(!result.error, "Did not expect error");
  return result;
}

function useMarkInboxNotificationAsRead_withClient(client: OpaqueClient) {
  return useCallback(
    (inboxNotificationId: string) => {
      const { store, notifications } = getExtrasForClient(client);

      const optimisticUpdateId = nanoid();
      const readAt = new Date();
      store.pushOptimisticUpdate({
        type: "mark-inbox-notification-as-read",
        id: optimisticUpdateId,
        inboxNotificationId,
        readAt,
      });

      notifications.markInboxNotificationAsRead(inboxNotificationId).then(
        () => {
          store.set((state) => {
            const existingNotification =
              state.inboxNotifications[inboxNotificationId];

            // If existing notification has been deleted, we return the existing state
            if (existingNotification === undefined) {
              return {
                ...state,
                optimisticUpdates: state.optimisticUpdates.filter(
                  (update) => update.id !== optimisticUpdateId
                ),
              };
            }

            return {
              ...state,
              inboxNotifications: {
                ...state.inboxNotifications,
                [inboxNotificationId]: {
                  ...existingNotification,
                  readAt,
                },
              },
              optimisticUpdates: state.optimisticUpdates.filter(
                (update) => update.id !== optimisticUpdateId
              ),
            };
          });
        },
        () => {
          // TODO: Broadcast errors to client
          store.set((state) => ({
            ...state,
            optimisticUpdates: state.optimisticUpdates.filter(
              (update) => update.id !== optimisticUpdateId
            ),
          }));
        }
      );
    },
    [client]
  );
}

function useMarkAllInboxNotificationsAsRead_withClient(client: OpaqueClient) {
  return useCallback(() => {
    const { store, notifications } = getExtrasForClient(client);
    const optimisticUpdateId = nanoid();
    const readAt = new Date();
    store.pushOptimisticUpdate({
      type: "mark-inbox-notifications-as-read",
      id: optimisticUpdateId,
      readAt,
    });

    notifications.markAllInboxNotificationsAsRead().then(
      () => {
        store.set((state) => ({
          ...state,
          inboxNotifications: Object.fromEntries(
            Array.from(Object.entries(state.inboxNotifications)).map(
              ([id, inboxNotification]) => [
                id,
                { ...inboxNotification, readAt },
              ]
            )
          ),
          optimisticUpdates: state.optimisticUpdates.filter(
            (update) => update.id !== optimisticUpdateId
          ),
        }));
      },
      () => {
        // TODO: Broadcast errors to client
        store.set((state) => ({
          ...state,
          optimisticUpdates: state.optimisticUpdates.filter(
            (update) => update.id !== optimisticUpdateId
          ),
        }));
      }
    );
  }, [client]);
}

function useInboxNotificationThread_withClient<M extends BaseMetadata>(
  client: OpaqueClient,
  inboxNotificationId: string
): ThreadData<M> {
  const { store } = getExtrasForClient<M>(client);

  const selector = useCallback(
    (state: CacheState<M>) => {
      const inboxNotification =
        state.inboxNotifications[inboxNotificationId] ??
        raise(`Inbox notification with ID "${inboxNotificationId}" not found`);

      if (inboxNotification.kind !== "thread") {
        raise(
          `Inbox notification with ID "${inboxNotificationId}" is not of kind "thread"`
        );
      }

      const thread =
        state.threads[inboxNotification.threadId] ??
        raise(
          `Thread with ID "${inboxNotification.threadId}" not found, this inbox notification might not be of kind "thread"`
        );

      return thread;
    },
    [inboxNotificationId]
  );

  return useSyncExternalStoreWithSelector(
    store.subscribe,
    store.get,
    store.get,
    selector
  );
}

function useUser_withClient<U extends BaseUserMeta>(
  client: Client<U>,
  userId: string
): UserState<U["info"]> {
  const usersStore = client[kInternal].usersStore;

  const getUserState = useCallback(
    () => usersStore.getState(userId),
    [usersStore, userId]
  );

  useEffect(() => {
    void usersStore.get(userId);
  }, [usersStore, userId]);

  const state = useSyncExternalStore(
    usersStore.subscribe,
    getUserState,
    getUserState
  );

  return state
    ? ({
        isLoading: state.isLoading,
        user: state.data,
        // Return an error if `undefined` was returned by `resolveUsers` for this user ID
        error:
          !state.isLoading && !state.data && !state.error
            ? missingUserError(userId)
            : state.error,
      } as UserState<U["info"]>)
    : { isLoading: true };
}

function useUserSuspense_withClient<U extends BaseUserMeta>(
  client: Client<U>,
  userId: string
) {
  const usersStore = client[kInternal].usersStore;

  const getUserState = useCallback(
    () => usersStore.getState(userId),
    [usersStore, userId]
  );
  const userState = getUserState();

  if (!userState || userState.isLoading) {
    throw usersStore.get(userId);
  }

  if (userState.error) {
    throw userState.error;
  }

  // Throw an error if `undefined` was returned by `resolveUsers` for this user ID
  if (!userState.data) {
    throw missingUserError(userId);
  }

  const state = useSyncExternalStore(
    usersStore.subscribe,
    getUserState,
    getUserState
  );

  return {
    isLoading: false,
    user: state?.data,
    error: state?.error,
  } as UserStateSuccess<U["info"]>;
}

function useRoomInfo_withClient(
  client: OpaqueClient,
  roomId: string
): RoomInfoState {
  const roomsInfoStore = client[kInternal].roomsInfoStore;

  const getRoomInfoState = useCallback(
    () => roomsInfoStore.getState(roomId),
    [roomsInfoStore, roomId]
  );

  useEffect(() => {
    void roomsInfoStore.get(roomId);
  }, [roomsInfoStore, roomId]);

  const state = useSyncExternalStore(
    roomsInfoStore.subscribe,
    getRoomInfoState,
    getRoomInfoState
  );

  return state
    ? ({
        isLoading: state.isLoading,
        info: state.data,
        // Return an error if `undefined` was returned by `resolveRoomsInfo` for this room ID
        error:
          !state.isLoading && !state.data && !state.error
            ? missingRoomInfoError(roomId)
            : state.error,
      } as RoomInfoState)
    : { isLoading: true };
}

function useRoomInfoSuspense_withClient(client: OpaqueClient, roomId: string) {
  const roomsInfoStore = client[kInternal].roomsInfoStore;

  const getRoomInfoState = useCallback(
    () => roomsInfoStore.getState(roomId),
    [roomsInfoStore, roomId]
  );
  const roomInfoState = getRoomInfoState();

  if (!roomInfoState || roomInfoState.isLoading) {
    throw roomsInfoStore.get(roomId);
  }

  if (roomInfoState.error) {
    throw roomInfoState.error;
  }

  // Throw an error if `undefined` was returned by `resolveRoomsInfo` for this room ID
  if (!roomInfoState.data) {
    throw missingRoomInfoError(roomId);
  }

  const state = useSyncExternalStore(
    roomsInfoStore.subscribe,
    getRoomInfoState,
    getRoomInfoState
  );

  return {
    isLoading: false,
    info: state?.data,
    error: state?.error,
  } as RoomInfoStateSuccess;
}

/** @internal */
export function createSharedContext<U extends BaseUserMeta>(
  client: Client<U>
): SharedContextBundle<U> {
  const useClient = () => client;
  return {
    classic: {
      useClient,
      useUser: (userId: string) => useUser_withClient(client, userId),
      useRoomInfo: (roomId: string) => useRoomInfo_withClient(client, roomId),
    },
    suspense: {
      useClient,
      useUser: (userId: string) => useUserSuspense_withClient(client, userId),
      useRoomInfo: (roomId: string) =>
        useRoomInfoSuspense_withClient(client, roomId),
    },
  };
}

/**
 * @private This is an internal API.
 */
function useEnsureNoLiveblocksProvider(options?: { allowNesting?: boolean }) {
  const existing = useClientOrNull();
  if (!options?.allowNesting && existing !== null) {
    throw new Error(
      "You cannot nest multiple LiveblocksProvider instances in the same React tree."
    );
  }
}

/**
 * @private This is an internal API.
 */
export function useClientOrNull<U extends BaseUserMeta>() {
  return useContext(ClientContext) as Client<U> | null;
}

/**
 * Obtains a reference to the current Liveblocks client.
 */
export function useClient<U extends BaseUserMeta>() {
  return (
    useClientOrNull<U>() ??
    raise("LiveblocksProvider is missing from the React tree.")
  );
}

/**
 * @private This is a private API.
 */
export function LiveblocksProviderWithClient(
  props: PropsWithChildren<{
    client: OpaqueClient;

    // Private flag, used only to skip the nesting check if this is
    // a LiveblocksProvider created implicitly by a factory-bound RoomProvider.
    allowNesting?: boolean;
  }>
) {
  useEnsureNoLiveblocksProvider(props);
  return (
    <ClientContext.Provider value={props.client}>
      {props.children}
    </ClientContext.Provider>
  );
}

/**
 * Sets up a client for connecting to Liveblocks, and is the recommended way to do
 * this for React apps. You must define either `authEndpoint` or `publicApiKey`.
 * Resolver functions should be placed inside here, and a number of other options
 * are available, which correspond with those passed to `createClient`.
 * Unlike `RoomProvider`, `LiveblocksProvider` doesn’t call Liveblocks servers when mounted,
 * and it should be placed higher in your app’s component tree.
 */
export function LiveblocksProvider<U extends BaseUserMeta = DU>(
  props: PropsWithChildren<ClientOptions<U>>
) {
  const { children, ...o } = props;

  // It's important that the static options remain stable, otherwise we'd be
  // creating new client instances on every render.
  const options = {
    publicApiKey: useInitial(o.publicApiKey),
    throttle: useInitial(o.throttle),
    lostConnectionTimeout: useInitial(o.lostConnectionTimeout),
    backgroundKeepAliveTimeout: useInitial(o.backgroundKeepAliveTimeout),
    polyfills: useInitial(o.polyfills),
    unstable_fallbackToHTTP: useInitial(o.unstable_fallbackToHTTP),
    unstable_streamData: useInitial(o.unstable_streamData),

    authEndpoint: useInitialUnlessFunction(o.authEndpoint),
    resolveMentionSuggestions: useInitialUnlessFunction(
      o.resolveMentionSuggestions
    ),
    resolveUsers: useInitialUnlessFunction(o.resolveUsers),
    resolveRoomsInfo: useInitialUnlessFunction(o.resolveRoomsInfo),

    baseUrl: useInitial(
      // @ts-expect-error - Hidden config options
      o.baseUrl as string | undefined
    ),
    enableDebugLogging: useInitial(
      // @ts-expect-error - Hidden config options
      o.enableDebugLogging as boolean | undefined
    ),
  } as ClientOptions<U>;

  // NOTE: Deliberately not passing any deps here, because we'll _never_ want
  // to recreate a client instance after the first render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const client = useMemo(() => createClient<U>(options), []);
  return (
    <LiveblocksProviderWithClient client={client}>
      {children}
    </LiveblocksProviderWithClient>
  );
}

/**
 * Creates a LiveblocksProvider and a set of typed hooks. Note that any
 * LiveblocksProvider created in this way takes no props, because it uses
 * settings from the given client instead.
 */
export function createLiveblocksContext<
  U extends BaseUserMeta = DU,
  M extends BaseMetadata = DM,
>(client: OpaqueClient): LiveblocksContextBundle<U, M> {
  return getOrCreateContextBundle<U, M>(client);
}

/**
 * Returns the inbox notifications for the current user.
 *
 * @example
 * const { inboxNotifications, error, isLoading } = useInboxNotifications();
 */
function useInboxNotifications() {
  return useInboxNotifications_withClient(useClient());
}

/**
 * Returns the inbox notifications for the current user.
 *
 * @example
 * const { inboxNotifications } = useInboxNotifications();
 */
function useInboxNotificationsSuspense() {
  return useInboxNotificationsSuspense_withClient(useClient());
}

function useInboxNotificationThread<M extends BaseMetadata>(
  inboxNotificationId: string
) {
  return useInboxNotificationThread_withClient<M>(
    useClient(),
    inboxNotificationId
  );
}

/**
 * Returns a function that marks all inbox notifications as read.
 *
 * @example
 * const markAllInboxNotificationsAsRead = useMarkAllInboxNotificationsAsRead();
 * markAllInboxNotificationsAsRead();
 */
function useMarkAllInboxNotificationsAsRead() {
  return useMarkAllInboxNotificationsAsRead_withClient(useClient());
}

/**
 * Returns a function that marks an inbox notification as read.
 *
 * @example
 * const markInboxNotificationAsRead = useMarkInboxNotificationAsRead();
 * markInboxNotificationAsRead("in_xxx");
 */
function useMarkInboxNotificationAsRead() {
  return useMarkInboxNotificationAsRead_withClient(useClient());
}

/**
 * Returns the number of unread inbox notifications for the current user.
 *
 * @example
 * const { count, error, isLoading } = useUnreadInboxNotificationsCount();
 */
function useUnreadInboxNotificationsCount() {
  return useUnreadInboxNotificationsCount_withClient(useClient());
}

/**
 * Returns the number of unread inbox notifications for the current user.
 *
 * @example
 * const { count } = useUnreadInboxNotificationsCount();
 */
function useUnreadInboxNotificationsCountSuspense() {
  return useUnreadInboxNotificationsCountSuspense_withClient(useClient());
}

function useUser<U extends BaseUserMeta>(userId: string) {
  const client = useClient<U>();
  return useUser_withClient(client, userId);
}

function useUserSuspense<U extends BaseUserMeta>(userId: string) {
  const client = useClient<U>();
  return useUserSuspense_withClient(client, userId);
}

/**
 * Returns room info from a given room ID.
 *
 * @example
 * const { info, error, isLoading } = useRoomInfo("room-id");
 */
function useRoomInfo(roomId: string) {
  return useRoomInfo_withClient(useClient(), roomId);
}

/**
 * Returns room info from a given room ID.
 *
 * @example
 * const { info } = useRoomInfo("room-id");
 */
function useRoomInfoSuspense(roomId: string) {
  return useRoomInfoSuspense_withClient(useClient(), roomId);
}

type TypedBundle = LiveblocksContextBundle<DU, DM>;

/**
 * Returns the thread associated with a `"thread"` inbox notification.
 *
 * @example
 * const thread = useInboxNotificationThread("in_xxx");
 */
const _useInboxNotificationThread: TypedBundle["useInboxNotificationThread"] =
  useInboxNotificationThread;

/**
 * Returns user info from a given user ID.
 *
 * @example
 * const { user, error, isLoading } = useUser("user-id");
 */
const _useUser: TypedBundle["useUser"] = useUser;

/**
 * Returns user info from a given user ID.
 *
 * @example
 * const { user } = useUser("user-id");
 */
const _useUserSuspense: TypedBundle["suspense"]["useUser"] = useUserSuspense;

// eslint-disable-next-line simple-import-sort/exports
export {
  _useInboxNotificationThread as useInboxNotificationThread,
  _useUser as useUser,
  _useUserSuspense as useUserSuspense,
  useInboxNotifications,
  useInboxNotificationsSuspense,
  useMarkAllInboxNotificationsAsRead,
  useMarkInboxNotificationAsRead,
  useRoomInfo,
  useRoomInfoSuspense,
  useUnreadInboxNotificationsCount,
  useUnreadInboxNotificationsCountSuspense,
};
