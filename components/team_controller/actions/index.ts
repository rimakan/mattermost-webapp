// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {batchActions} from 'redux-batched-actions';

import {Team} from '@mattermost/types/teams';
import {ServerError} from '@mattermost/types/errors';

import {ActionFunc} from 'mattermost-redux/types/actions';
import {ChannelTypes} from 'mattermost-redux/action_types';
import {getTeamByName, selectTeam} from 'mattermost-redux/actions/teams';
import {forceLogoutIfNecessary} from 'mattermost-redux/actions/helpers';
import {fetchMyChannelsAndMembersREST} from 'mattermost-redux/actions/channels';
import {getGroups, getAllGroupsAssociatedToChannelsInTeam, getAllGroupsAssociatedToTeam, getGroupsByUserIdPaginated} from 'mattermost-redux/actions/groups';
import {logError} from 'mattermost-redux/actions/errors';
import {isCustomGroupsEnabled, isGraphQLEnabled} from 'mattermost-redux/selectors/entities/preferences';
import {getCurrentUser} from 'mattermost-redux/selectors/entities/users';
import {getLicense} from 'mattermost-redux/selectors/entities/general';
import {isGuest} from 'mattermost-redux/utils/user_utils';

import {isSuccess} from 'types/actions';

import {loadStatusesForChannelAndSidebar} from 'actions/status_actions';
import {addUserToTeam} from 'actions/team_actions';
import {fetchChannelsAndMembers} from 'actions/channel_actions';

import LocalStorageStore from 'stores/local_storage_store';

export function initializeTeam(team: Team): ActionFunc<Team, ServerError> {
    return async (dispatch, getState) => {
        dispatch(batchActions([
            selectTeam(team.id),
            {
                type: ChannelTypes.GET_CHANNELS_AND_CHANNEL_MEMBERS_REQUEST,
                data: null,
            },
        ]));

        const state = getState();
        const currentUser = getCurrentUser(state);
        LocalStorageStore.setPreviousTeamId(currentUser.id, team.id);

        if (isGuest(currentUser.roles)) {
            // Will be fixed in MM-48260
            dispatch({type: ChannelTypes.GET_CHANNELS_AND_CHANNEL_MEMBERS_FAILURE, error: null});
        }

        const graphQLEnabled = isGraphQLEnabled(state);
        try {
            if (graphQLEnabled) {
                await dispatch(fetchChannelsAndMembers(team.id));
            } else {
                await dispatch(fetchMyChannelsAndMembersREST(team.id));
            }

            await dispatch({type: ChannelTypes.GET_CHANNELS_AND_CHANNEL_MEMBERS_SUCCESS, data: null});
        } catch (error) {
            dispatch({type: ChannelTypes.GET_CHANNELS_AND_CHANNEL_MEMBERS_FAILURE, error});
            forceLogoutIfNecessary(error as ServerError, dispatch, getState);
            dispatch(logError(error as ServerError));
            return {error: error as ServerError};
        }

        dispatch(loadStatusesForChannelAndSidebar());

        const license = getLicense(state);
        const customGroupEnabled = isCustomGroupsEnabled(state);
        if (license &&
            license.IsLicensed === 'true' &&
            (license.LDAPGroups === 'true' || customGroupEnabled)) {
            if (currentUser) {
                dispatch(getGroupsByUserIdPaginated(currentUser.id, false, 0, 60, true));
            }

            if (license.LDAPGroups === 'true') {
                dispatch(getAllGroupsAssociatedToChannelsInTeam(team.id, true));
            }

            if (team.group_constrained && license.LDAPGroups === 'true') {
                dispatch(getAllGroupsAssociatedToTeam(team.id, true));
            } else {
                dispatch(getGroups(false, 0, 60, true));
            }
        }

        return {data: team};
    };
}

export function joinTeam(teamname: string, joinedOnFirstLoad: boolean): ActionFunc<Team, ServerError> {
    return async (dispatch, getState) => {
        const state = getState();
        const currentUser = getCurrentUser(state);

        try {
            const teamByNameResult = await dispatch(getTeamByName(teamname));
            if (isSuccess(teamByNameResult)) {
                const team = teamByNameResult.data;

                if (currentUser && team && team.delete_at === 0) {
                    const addUserToTeamResult = await dispatch(addUserToTeam(team.id, currentUser.id));
                    if (isSuccess(addUserToTeamResult)) {
                        if (joinedOnFirstLoad) {
                            LocalStorageStore.setTeamIdJoinedOnLoad(team.id);
                        }

                        await dispatch(initializeTeam(team));

                        return {data: team};
                    }
                    throw addUserToTeamResult.error;
                }
                throw new Error('Team not found or deleted');
            } else {
                throw teamByNameResult.error;
            }
        } catch (error) {
            forceLogoutIfNecessary(error as ServerError, dispatch, getState);
            dispatch(logError(error as ServerError));
            return {error: error as ServerError};
        }
    };
}
