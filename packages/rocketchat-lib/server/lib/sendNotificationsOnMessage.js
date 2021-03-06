import moment from 'moment';

import { callJoinRoom, messageContainsHighlight, parseMessageTextPerUser, replaceMentionedUsernamesWithFullNames } from '../functions/notifications/';
import { sendEmail, shouldNotifyEmail } from '../functions/notifications/email';
import { sendSinglePush, shouldNotifyMobile } from '../functions/notifications/mobile';
import { notifyDesktopUser, shouldNotifyDesktop } from '../functions/notifications/desktop';
import { notifyAudioUser, shouldNotifyAudio } from '../functions/notifications/audio';

const sendNotification = ({
	subscription,
	sender,
	hasMentionToAll,
	hasMentionToHere,
	message,
	notificationMessage,
	room,
	mentionIds,
	disableAllMessageNotifications
}) => {

	// don't notify the sender
	if (subscription.u._id === sender._id) {
		return;
	}

	// notifications disabled
	if (subscription.disableNotifications) {
		return;
	}

	// dont send notification to users who ignored the sender
	if (Array.isArray(subscription.ignored) && subscription.ignored.find(sender._id)) {
		return;
	}

	const hasMentionToUser = mentionIds.includes(subscription.u._id);

	// mute group notifications (@here and @all) if not directly mentioned as well
	if (!hasMentionToUser && subscription.muteGroupMentions && (hasMentionToAll || hasMentionToHere)) {
		return;
	}

	const receiver = RocketChat.models.Users.findOneById(subscription.u._id);

	if (!receiver || !receiver.active) {
		return;
	}

	notificationMessage = parseMessageTextPerUser(notificationMessage, receiver);

	const isHighlighted = messageContainsHighlight(message, subscription.userHighlights);

	const roomType = room.t;

	const {
		audioNotifications,
		desktopNotifications,
		mobilePushNotifications,
		emailNotifications
	} = subscription;

	let notificationSent = false;

	// busy users don't receive audio notification
	if (shouldNotifyAudio({
		disableAllMessageNotifications,
		status: receiver.status,
		audioNotifications,
		hasMentionToAll,
		hasMentionToHere,
		isHighlighted,
		hasMentionToUser,
		roomType
	})) {
		notifyAudioUser(subscription.u._id, message, room);
	}

	// busy users don't receive desktop notification
	if (shouldNotifyDesktop({
		disableAllMessageNotifications,
		status: receiver.status,
		desktopNotifications,
		hasMentionToAll,
		hasMentionToHere,
		isHighlighted,
		hasMentionToUser,
		roomType
	})) {
		notificationSent = true;
		notifyDesktopUser({
			notificationMessage,
			userId: subscription.u._id,
			user: sender,
			message,
			room,
			duration: subscription.desktopNotificationDuration
		});
	}

	if (shouldNotifyMobile({
		disableAllMessageNotifications,
		mobilePushNotifications,
		hasMentionToAll,
		isHighlighted,
		hasMentionToUser,
		statusConnection: receiver.statusConnection,
		roomType
	})) {
		notificationSent = true;

		sendSinglePush({
			notificationMessage,
			room,
			message,
			userId: subscription.u._id,
			senderUsername: sender.username,
			receiverUsername: receiver.username
		});
	}

	if (receiver.emails && shouldNotifyEmail({
		disableAllMessageNotifications,
		statusConnection: receiver.statusConnection,
		emailNotifications,
		isHighlighted,
		hasMentionToUser,
		hasMentionToAll,
		roomType
	})) {
		receiver.emails.some((email) => {
			if (email.verified) {
				sendEmail({ message, receiver, subscription, room, emailAddress: email.address });

				return true;
			}
		});
	}

	if (notificationSent) {
		RocketChat.Sandstorm.notify(message, [subscription.u._id], `@${ sender.username }: ${ message.msg }`, room.t === 'p' ? 'privateMessage' : 'message');
	}
};

function sendAllNotifications(message, room) {

	// skips this callback if the message was edited
	if (message.editedAt) {
		return message;
	}

	if (message.ts && Math.abs(moment(message.ts).diff()) > 60000) {
		return message;
	}

	if (!room || room.t == null) {
		return message;
	}

	const sender = (room.t !== 'l') ? RocketChat.models.Users.findOneById(message.u._id) : room.v;
	if (!sender) {
		return message;
	}

	const mentionIds = (message.mentions || []).map(({_id}) => _id);
	const mentionIdsWithoutGroups = mentionIds.filter((_id) => _id !== 'all' && _id !== 'here');
	const hasMentionToAll = mentionIds.includes('all');
	const hasMentionToHere = mentionIds.includes('here');

	let notificationMessage = RocketChat.callbacks.run('beforeSendMessageNotifications', message.msg);
	if (mentionIds.length > 0 && RocketChat.settings.get('UI_Use_Real_Name')) {
		notificationMessage = replaceMentionedUsernamesWithFullNames(message.msg, message.mentions);
	}

	// Don't fetch all users if room exceeds max members
	const maxMembersForNotification = RocketChat.settings.get('Notifications_Max_Room_Members');
	const disableAllMessageNotifications = room.usernames.length > maxMembersForNotification && maxMembersForNotification !== 0;

	const query = {
		rid: room._id,
		$or: [{
			'userHighlights.0': { $exists: 1 }
		}]
	};

	['audio', 'desktop', 'mobile', 'email'].map((kind) => {
		const notificationField = `${ kind === 'mobile' ? 'mobilePush' : kind }Notifications`;

		const filter = { [notificationField]: 'all' };

		if (disableAllMessageNotifications) {
			filter[`${ kind }PrefOrigin`] = { $ne: 'user' };
		}

		query.$or.push(filter);

		if (mentionIdsWithoutGroups.length > 0) {
			query.$or.push({
				[notificationField]: 'mentions',
				'u._id': { $in: mentionIdsWithoutGroups }
			});
		}

		const serverField = kind === 'email' ? 'emailNotificationMode' : `${ kind }Notifications`;
		const serverPreference = RocketChat.settings.get(`Accounts_Default_User_Preferences_${ serverField }`);
		if ((room.t === 'd' && serverPreference === 'mentions') || (serverPreference === 'all' && !disableAllMessageNotifications)) {
			query.$or.push({
				[notificationField]: { $exists: false }
			});
		} else if (serverPreference === 'mentions' && mentionIdsWithoutGroups.length) {
			query.$or.push({
				[notificationField]: { $exists: false },
				'u._id': { $in: mentionIdsWithoutGroups }
			});
		}
	});

	// the find bellow is crucial. all subscription records returned will receive at least one kind of notification.
	// the query is defined by the server's default values and Notifications_Max_Room_Members setting.
	const subscriptions = RocketChat.models.Subscriptions.findNotificationPreferencesByRoom(query);
	subscriptions.forEach((subscription) => sendNotification({
		subscription,
		sender,
		hasMentionToAll,
		hasMentionToHere,
		message,
		notificationMessage,
		room,
		mentionIds,
		disableAllMessageNotifications
	}));

	// on public channels, if a mentioned user is not member of the channel yet, he will first join the channel and then be notified based on his preferences.
	if (room.t === 'c') {
		Promise.all(message.mentions
			.filter(({ _id, username }) => _id !== 'here' && _id !== 'all' && !room.usernames.includes(username))
			.map(async(user) => {
				await callJoinRoom(user, room._id);

				return user._id;
			})
		).then((users) => {
			users.forEach((userId) => {
				const subscription = RocketChat.models.Subscriptions.findOneByRoomIdAndUserId(room._id, userId);

				sendNotification({
					subscription,
					sender,
					hasMentionToAll,
					hasMentionToHere,
					message,
					notificationMessage,
					room,
					mentionIds
				});
			});
		});
	}

	return message;
}

RocketChat.callbacks.add('afterSaveMessage', sendAllNotifications, RocketChat.callbacks.priority.LOW, 'sendNotificationsOnMessage');
