
what backend is it using
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {useEffect, useState} from 'react';
import {useNavigate} from 'react-router-dom';

import {API_URL, APP_VERSION, LS_KEY_USER_SUBS} from './constants.js';
import {NetworkError} from './errors.js';
import {useNotifierContext} from './NotifierContext.jsx';
import {getLastFinishedAtsForMeso} from './utils/index.js';
import logError from './utils/logError.js';
import {addQueryParams, runAfterAnimations} from './utils/misc.js';
import storage from './utils/storage.js';
import useToken from './utils/useToken.js';

export function retry(failureCount, error) {
  if (error.statusCode >= 400 && error.statusCode < 500) {
    return false;
  }

  return failureCount < 3;
}

async function processHttpError(res) {
  const contentType = res.headers.get('content-type');
  const isCDN404 = contentType.includes('text/html') && res.statusCode === 200;

  let err;
  if (isCDN404) {
    err = new NetworkError(`Error: 404 munged by cloudfront into HTML`, 404);
  } else {
    err = new NetworkError(`Error: ${res.status} ${res.statusText}`, res.status);
  }

  let parsedBody = null;
  if (err.statusCode !== 404) {
    // CloudFront serves the index html for 404s so there's no chance we're getting a usable json body.
    try {
      parsedBody = await res.json();
    } catch (jsonErr) {
      // We did everything we could, no usable body.
    }
  }
  err.body = parsedBody;

  throw err;
}

async function processHttpResponse(res) {
  if (res.ok) {
    if (res.status === 204) {
      return null;
    }

    const contentType = res.headers.get('content-type');

    // NOTE: we are using an API proxy through Cloudfront. Because we have a SPA, we handle 403s and 404s
    // by serving index.html with a 200 status code. This means that any APIs that correctly return
    // these status code will be totally broken in the app.
    // For example, a GET /user/profile with a valid token for an account that doesn't exist anymore will
    // get back the index.html file

    // This function is used only at the API layer for this application, and we know that we NEVER
    // fetch HTML using any of our API utils, so we will consider HTML content types as error cases
    // that require special handling
    const isCDN404 = contentType.includes('text/html');

    if (!isCDN404) {
      const isJson = contentType.includes('application/json');
      if (isJson) {
        try {
          return await res.json();
        } catch (err) {
          return null;
        }
      }

      try {
        return await res.text();
      } catch (err) {
        return null;
      }
    }
  }

  await processHttpError(res);
}

function useGoodQuery(...args) {
  const res = useQuery(...args);

  // NOTE: react-query is broken. If enabled is false, it isLoading is always true
  // https://github.com/TanStack/query/issues/3975
  // Workaround: https://github.com/TanStack/query/issues/3975#issuecomment-1244075132
  res.isActuallyLoading = res.isLoading && res.fetchStatus !== 'idle';

  return res;
}

function useGoodMutation(...args) {
  const res = useMutation(...args);

  const [isWorking, setIsWorking] = useState(false);

  useEffect(() => {
    let timeoutId;

    if (res.isLoading) {
      setIsWorking(true);
    } else {
      timeoutId = runAfterAnimations(() => {
        setIsWorking(false);
      });
    }

    return () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };
  }, [res.isLoading]);

  return {...res, isWorking};
}

function useFetch(endpoint) {
  const token = useToken();

  return async () => {
    const res = await fetch(addQueryParams(`${API_URL}${endpoint}`, {v: APP_VERSION}), {
      headers: {
        authorization: `Bearer ${token}`,
        'Accept-Version': APP_VERSION,
        'x-app': 'training',
        'x-app-version': APP_VERSION,
      },
    });

    return processHttpResponse(res);
  };
}

function usePost(endpoint) {
  const token = useToken();

  return async data => {
    const res = await fetch(addQueryParams(`${API_URL}${endpoint}`, {v: APP_VERSION}), {
      method: 'POST',
      headers: {
        'accept-version': APP_VERSION,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-app': 'training',
        'x-app-version': APP_VERSION,
      },
      body: JSON.stringify(data),
    });

    return processHttpResponse(res);
  };
}

function usePut(endpoint) {
  const token = useToken();

  return async data => {
    const res = await fetch(addQueryParams(`${API_URL}${endpoint}`, {v: APP_VERSION}), {
      method: 'PUT',
      headers: {
        'accept-version': APP_VERSION,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-app': 'training',
        'x-app-version': APP_VERSION,
      },
      body: JSON.stringify(data),
    });

    return processHttpResponse(res);
  };
}

function useDelete(endpoint) {
  const token = useToken();

  return async (options = {}) => {
    // TODO I couldn't figure out where this query is passed in from in order to convert it over to addQueryParams.
    const url = `${API_URL}${endpoint}${options?.query ? `?${options.query}` : ''}`;
    const res = await fetch(addQueryParams(url, {v: APP_VERSION}), {
      method: 'DELETE',
      headers: {
        'accept-version': APP_VERSION,
        authorization: `Bearer ${token}`,
        'x-app': 'training',
        'x-app-version': APP_VERSION,
      },
    });

    return processHttpResponse(res);
  };
}

export function useAppConfig(options = {}) {
  const token = useToken();

  const getAppConfig = async () => {
    const res = await fetch(
      addQueryParams(`${API_URL}${`/apps/training/rp/${APP_VERSION}/config.json`}`, {
        v: APP_VERSION,
      }),
      {
        headers: {
          authorization: `Bearer ${token}`,
          'Accept-Version': APP_VERSION,
        },
      }
    );

    const info = await processHttpResponse(res);
    const serverDate = new Date(res.headers.get('date'));

    return {info, serverDate};
  };

  return useGoodQuery(['config'], getAppConfig, {
    // https://tanstack.com/query/v4/docs/react/reference/useQuery
    // If set to true, the query will refetch on window focus if the data is stale.
    staleTime: 15 * 60 * 1000, // 15 mins
    ...options,
    meta: {
      name: 'useAppConfig()',
      ...options.meta,
    },
  });
}

// user db record + user attributes
export function useUserProfile(options = {}) {
  const getUserProfile = useFetch('/user/profile');
  return useGoodQuery(['user'], getUserProfile, {
    ...options,
    meta: {
      name: 'useUserProfile()',
      ...options.meta,
    },
  });
}

// user referral code entries
export function useUserReferrals(options = {}) {
  const getUserReferrals = useFetch('/user/referrals');
  return useGoodQuery(['userReferrals'], getUserReferrals, {
    ...options,
    meta: {
      name: 'useUserReferrals()',
      ...options.meta,
    },
  });
}

// user subscription info
export function useUserSubscriptions(options = {}) {
  const getUserSubs = useFetch('/user/subscriptions');

  const persistedSubsData = storage.getItem(LS_KEY_USER_SUBS);

  const gracePeriod = 24 * 60 * 60 * 1000; // 24 hours
  const shouldRefetch =
    !persistedSubsData ||
    persistedSubsData?.activeSubscriptions?.length === 0 ||
    Date.now() > persistedSubsData?.updatedAt + gracePeriod;

  const queryConfig = {
    ...options,
    onSuccess: subs => {
      storage.setItem(LS_KEY_USER_SUBS, {...subs, updatedAt: Date.now()});

      if (options.onSuccess) {
        options.onSuccess(subs);
      }
    },
    onError: error => {
      storage.removeItem(LS_KEY_USER_SUBS);

      if (options.onError) {
        options.onError(error);
      }
    },
    meta: {
      name: 'useUserSubscriptions()',
      ...options.meta,
    },
  };

  // NOTE: this is behind this flag because passing initialData of null with staleTime 0
  // results in useUserSubscriptions never setting isLoading = true, causing a flash on whatever
  // page depends on the .isActuallyLoading parameter to control rendering
  if (persistedSubsData) {
    // Don't refetch unless we have no active subscriptions or 24 hours have passed.
    // We check on every load if there are no active subscriptions to avoid staleness on
    // transition from no subs to having subs)
    queryConfig.staleTime = shouldRefetch ? 0 : Infinity;
    queryConfig.initialData = persistedSubsData;
  }

  return useGoodQuery(['userSubs'], getUserSubs, queryConfig);
}

export function useBootstrap() {
  const queryClient = useQueryClient();

  const [isBootstrapped, setIsBootstrapped] = useState(false);

  const {data, error} = useGoodQuery(['bootstrap'], useFetch('/training/bootstrap'), {
    cacheTime: 0, // toss the cache right away
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    meta: {
      name: 'useBootstrap()',
    },
  });

  useEffect(() => {
    if (data && !isBootstrapped) {
      queryClient.setQueryData(['muscleGroups'], data.muscleGroups);
      queryClient.setQueryData(['exercises'], data.exercises);
      queryClient.setQueryData(['mesocycles'], data.mesocycles);
      if (data.currentMesocycle) {
        queryClient.setQueryData(['mesocycle', data.currentMesocycle.key], data.currentMesocycle);
      }

      setIsBootstrapped(true);
    }
  }, [data, isBootstrapped, queryClient]);

  return {isBootstrapped, error};
}

export function useMuscleGroups(options = {}) {
  const getMuscleGroups = useFetch('/training/muscle-groups');
  return useGoodQuery(['muscleGroups'], getMuscleGroups, {
    ...options,
    meta: {
      name: 'useMuscleGroups()',
      ...options.meta,
    },
  });
}

export function useExercises(options = {}) {
  const getExercises = useFetch('/training/exercises');
  return useGoodQuery(['exercises'], getExercises, {
    ...options,
    meta: {
      name: 'useExercises()',
      ...options.meta,
    },
  });
}

export function useExerciseTypes(options = {}) {
  const getExerciseTypes = useFetch('/training/exercise-types');
  return useGoodQuery(['exerciseTypes'], getExerciseTypes, {
    ...options,
    meta: {
      name: 'useExerciseTypes()',
      ...options.meta,
    },
  });
}

export function useMesocycle(key, options = {}) {
  const navigate = useNavigate();
  const {showNotification} = useNotifierContext();
  const getMeso = useFetch(`/training/mesocycles/${key}`);

  const query = useGoodQuery(['mesocycle', key], getMeso, {
    ...options,
    meta: {
      name: 'useMesocycle()',
      ...options.meta,
    },
  });

  useEffect(() => {
    if (query.error) {
      if (query.error.statusCode >= 400 && query.error.statusCode < 500) {
        navigate('/mesocycles');
        showNotification({
          message: `Looks like that mesocycle isn't available anymore`,
          type: 'error',
          autoClose: true,
        });
      }
    }
  }, [navigate, options, query.error, showNotification]);

  return query;
}

export function useMesocycles(options = {}) {
  const getMesos = useFetch('/training/mesocycles');
  return useGoodQuery(['mesocycles'], getMesos, {
    ...options,
    meta: {
      name: 'useMesocycles()',
      ...options.meta,
    },
  });
}

/* TEMPLATES */

export function useTemplateEmphases(options = {}) {
  const getTemplateEmphases = useFetch('/training/templates/emphases');

  return useGoodQuery(['templateEmphases'], getTemplateEmphases, {
    ...options,
    meta: {
      name: 'useTemplateEmphases()',
      ...options.meta,
    },
  });
}

export function useTemplates(options) {
  const getTemplates = useFetch('/training/templates');
  return useGoodQuery(['templates'], getTemplates, {
    ...options,
    meta: {
      name: 'useTemplates()',
      ...options?.meta,
    },
  });
}

export function useTemplate(templateKey, options) {
  const getTemplate = useFetch(`/training/templates/${templateKey}`);
  return useGoodQuery(['template', templateKey], getTemplate, {
    ...options,
    meta: {
      name: 'useTemplate()',
      ...options?.meta,
    },
  });
}

export function useCreateTemplate() {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost('/training/templates'),
    onSuccess: template => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['template', template.key], template);
        queryClient.invalidateQueries(['templates']);
      });
    },
  });
}

export function useUpdateTemplate(templateKey, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/templates/${templateKey}`),
    ...options,
    onSuccess: newTemplate => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['template', newTemplate.key], newTemplate);

        queryClient.setQueryData(['templates'], oldTemplates => {
          // direct page load of /templates/:templateKey won't fetch all templates
          if (oldTemplates) {
            oldTemplates.map(oldTemplate => {
              return oldTemplate.key === newTemplate.key
                ? {
                    ...oldTemplate,
                    emphasis: newTemplate.emphasis,
                    frequency: newTemplate.days.length,
                    name: newTemplate.name,
                    sex: newTemplate.sex,
                    updatedAt: newTemplate.updatedAt,
                  }
                : oldTemplate;
            });
          }
        });
      });
      if (options.onSuccess) {
        options.onSuccess(newTemplate);
      }
    },
    meta: {
      name: 'useUpdateTemplate()',
      ...options.meta,
    },
  });
}

export function useDeleteTemplate(templateKey, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: useDelete(`/training/templates/${templateKey}`),
    ...options,
    onSuccess: () => {
      const clearCache = () =>
        runAfterAnimations(() => {
          queryClient.setQueryData(['templates'], templates => {
            return templates.filter(temp => temp.key !== templateKey);
          });
          queryClient.removeQueries({queryKey: ['template', templateKey], exact: true});
        });

      if (options.onSuccess) {
        options.onSuccess(clearCache);
      } else {
        clearCache();
      }
    },
    meta: {
      name: 'useDeleteTemplate()',
      ...options.meta,
    },
  });
}

/* MUTATIONS */

// Exercises
export function useCreateExercise(options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost('/training/exercises'),
    ...options,
    onSuccess: ({exerciseId, exercises}) => {
      runAfterAnimations(() => queryClient.setQueryData(['exercises'], exercises));
      if (options.onSuccess) {
        options.onSuccess({exerciseId, exercises});
      }
    },
    meta: {
      name: 'useCreateExercise()',
      ...options.meta,
    },
  });
}

export function useUpdateExercise(exerciseId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/exercises/${exerciseId}`),
    ...options,
    onSuccess: updatedExercise => {
      runAfterAnimations(() =>
        queryClient.setQueryData(['exercises'], exercises => {
          return exercises.map(ex => {
            return ex.id === updatedExercise.id
              ? {
                  ...ex,
                  ...updatedExercise,
                }
              : ex;
          });
        })
      );

      if (options.onSuccess) {
        options.onSuccess(updatedExercise);
      }
    },
    meta: {
      name: 'useUpdateExercise()',
      ...options.meta,
    },
  });
}

export function useDeleteExercise(exerciseId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: useDelete(`/training/exercises/${exerciseId}`),
    ...options,
    onSuccess: updatedExercise => {
      runAfterAnimations(() =>
        queryClient.setQueryData(['exercises'], exercises => {
          return exercises.map(ex => {
            return ex.id === updatedExercise.id
              ? {
                  ...ex,
                  ...updatedExercise,
                }
              : ex;
          });
        })
      );

      if (options.onSuccess) {
        options.onSuccess(updatedExercise);
      }
    },
    meta: {
      name: 'useDeleteExercise()',
      ...options.meta,
    },
  });
}

// Mesos
export function useCreateMeso(options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost('/training/mesocycles'),
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
        queryClient.invalidateQueries(['mesocycles']);
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useCreateMeso()',
      ...options.meta,
    },
  });
}

export function useUpdateMeso(mesoKey, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/mesocycles/${mesoKey}`),
    retry,
    ...options,
    onSuccess: updatedMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', updatedMeso.key], updatedMeso);

        queryClient.setQueryData(['mesocycles'], oldMesos =>
          oldMesos.map(oldMeso => {
            return oldMeso.key === updatedMeso.key
              ? {
                  ...oldMeso,
                  name: updatedMeso.name,
                  finishedAt: updatedMeso.finishedAt,
                }
              : oldMeso;
          })
        );
      });

      if (options.onSuccess) {
        options.onSuccess(updatedMeso);
      }
    },
    meta: {
      name: 'useUpdateMeso()',
      ...options.meta,
    },
  });
}

export function useDeleteMeso(mesoKey, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: useDelete(`/training/mesocycles/${mesoKey}`),
    ...options,
    onSuccess: () => {
      const clearCache = () => {
        runAfterAnimations(() => {
          queryClient.setQueryData(['mesocycles'], oldMesos =>
            oldMesos.filter(meso => meso.key !== mesoKey)
          );
          queryClient.removeQueries({queryKey: ['mesocycle', mesoKey], exact: true});
        });
      };

      if (options.onSuccess) {
        options.onSuccess(clearCache);
      } else {
        clearCache();
      }
    },
    meta: {
      name: 'useDeleteMeso()',
      ...options.meta,
    },
  });
}

export function useUpdateMesoProgressions(mesoKey, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/mesocycles/${mesoKey}/progressions`),
    ...options,
    onSuccess: newProgressions => {
      queryClient.setQueryData(['mesocycle', mesoKey], oldMeso => ({
        ...oldMeso,
        progressions: newProgressions,
      }));
    },
    meta: {
      name: 'useUpdateMesoProgressions()',
      ...options.meta,
    },
  });
}

// Meso Day
export function useUpdateDay(dayId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/days/${dayId}`),
    retry,
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
        queryClient.setQueryData(['mesocycles'], oldMesos => {
          const {lastFinishedAtDay, lastFinishedAtSet} = getLastFinishedAtsForMeso(newMeso);
          return oldMesos.map(oldMeso => {
            if (oldMeso.key !== newMeso.key) {
              return oldMeso;
            }

            return {
              ...oldMeso,
              lastFinishedAtDay,
              lastFinishedAtSet,
            };
          });
        });
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useUpdateDay()',
      ...options.meta,
    },
  });
}

export function useUpdateDayBodyweight(dayId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/days/${dayId}/bodyweight`),
    retry,
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });
      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useUpdateDayBodyweight()',
      ...options.meta,
    },
  });
}

export function useUpdateDayLabel(dayId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/days/${dayId}/label`),
    retry,
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });
      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useUpdateDayLabel()',
      ...options.meta,
    },
  });
}

// MONKEY
export function useAddDayExercise(dayId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost(`/training/days/${dayId}/exercises`),
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useAddDayExercise()',
      ...options.meta,
    },
  });
}

export function useReplaceDayExercise(dayId, dayExerciseId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/days/${dayId}/exercises/${dayExerciseId}`),
    retry,
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useReplaceDayExercise()',
      ...options.meta,
    },
  });
}

export function useMoveDayExercise(dayId, dayExerciseId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/days/${dayId}/exercises/${dayExerciseId}/move`),
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useMoveDayExercise()',
      ...options.meta,
    },
  });
}

export function useDeleteDayExercise(dayId, dayExerciseId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: useDelete(`/training/days/${dayId}/exercises/${dayExerciseId}`),
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useDeleteDayExercise()',
      ...options.meta,
    },
  });
}

export function useUpdateRepsActual(mesoKey, setId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/sets/${setId}/updateReps`),
    retry,
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', mesoKey], newMeso);
      });
    },
    meta: {
      name: 'useUpdateRepsActual()',
      ...options.meta,
    },
  });
}

// MESO NOTES

function getMesoWithUpdatedNotes(meso, newMesoNotes) {
  return {
    ...meso,
    notes: newMesoNotes,
  };
}
function getMesosWithUpdatedNotes(mesos, mesoKeyWithUpdates, newMesoNotes) {
  return mesos.map(meso =>
    meso.key === mesoKeyWithUpdates ? getMesoWithUpdatedNotes(meso, newMesoNotes) : meso
  );
}
function getMesoWithFilteredNotes(meso, deletedMesoNoteId) {
  return {
    ...meso,
    notes: meso.notes.filter(mesoNote => mesoNote.id !== deletedMesoNoteId),
  };
}

export function useCreateMesoNote(mesoKey, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost(`/training/mesocycles/${mesoKey}/notes`),
    ...options,
    onSuccess: mesoNotesWithText => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', mesoKey], meso => {
          if (meso) {
            return getMesoWithUpdatedNotes(meso, mesoNotesWithText);
          }
        });
        queryClient.setQueryData(['mesocycles'], mesos => {
          if (mesos) {
            return getMesosWithUpdatedNotes(mesos, mesoKey, mesoNotesWithText);
          }
        });
      });

      if (options.onSuccess) {
        options.onSuccess(mesoNotesWithText);
      }
    },
    meta: {
      name: 'useCreateMesoNote()',
      ...options.meta,
    },
  });
}

export function useUpdateMesoNote(mesoKey, mesoNoteId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/mesocycles/${mesoKey}/notes/${mesoNoteId}`),
    retry,
    ...options,
    onSuccess: mesoNotesWithText => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', mesoKey], meso => {
          if (meso) {
            return getMesoWithUpdatedNotes(meso, mesoNotesWithText);
          }
        });
        queryClient.setQueryData(['mesocycles'], mesos => {
          if (mesos) {
            return getMesosWithUpdatedNotes(mesos, mesoKey, mesoNotesWithText);
          }
        });
      });

      if (options.onSuccess) {
        options.onSuccess(mesoNotesWithText);
      }
    },
    meta: {
      name: 'useUpdateMesoNote()',
      ...options.meta,
    },
  });
}

export function useDeleteMesoNote(mesoKey, mesoNoteId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: useDelete(`/training/mesocycles/${mesoKey}/notes/${mesoNoteId}`),
    ...options,
    onSuccess: () => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', mesoKey], meso => {
          if (meso) {
            return getMesoWithFilteredNotes(meso, mesoNoteId);
          }
        });
        queryClient.setQueryData(['mesocycles'], mesos => {
          if (mesos) {
            return mesos.map(meso =>
              meso.key === mesoKey ? getMesoWithFilteredNotes(meso, mesoNoteId) : meso
            );
          }
        });
      });

      if (options.onSuccess) {
        options.onSuccess();
      }
    },
    meta: {
      name: 'useDeleteMesoNote()',
      ...options.meta,
    },
  });
}

// DAY NOTES

export function useCreateDayNote(dayId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost(`/training/days/${dayId}/notes`),
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useCreateDayNote()',
      ...options.meta,
    },
  });
}

export function useUpdateDayNote(dayId, dayNoteId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/days/${dayId}/notes/${dayNoteId}`),
    retry,
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useUpdateDayNote()',
      ...options.meta,
    },
  });
}

export function useDeleteDayNote(dayId, dayNoteId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: useDelete(`/training/days/${dayId}/notes/${dayNoteId}`),
    ...options,
    onSuccess: newMeso => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['mesocycle', newMeso.key], newMeso);
      });

      if (options.onSuccess) {
        options.onSuccess(newMeso);
      }
    },
    meta: {
      name: 'useDeleteDayNote()',
      ...options.meta,
    },
  });
}

// EXERCISE NOTES

function getUpdatedExercisesWithNotes(exercises, exerciseId, exerciseNotes) {
  return exercises.map(exercise =>
    exercise.id === exerciseId
      ? {
          ...exercise,
          notes: exerciseNotes,
        }
      : exercise
  );
}

export function useCreateExerciseNote(exerciseId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost(`/training/exercises/${exerciseId}/notes`),
    ...options,
    onSuccess: exerciseNotesWithText => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['exercises'], exercises => {
          if (exercises) {
            return getUpdatedExercisesWithNotes(exercises, exerciseId, exerciseNotesWithText);
          }
        });
      });

      if (options.onSuccess) {
        options.onSuccess(exerciseNotesWithText);
      }
    },
    meta: {
      name: 'useCreateExerciseNote()',
      ...options.meta,
    },
  });
}

export function useUpdateExerciseNote(exerciseId, exerciseNoteId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut(`/training/exercises/${exerciseId}/notes/${exerciseNoteId}`),
    retry,
    ...options,
    onSuccess: exerciseNotesWithText => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['exercises'], exercises => {
          if (exercises) {
            return getUpdatedExercisesWithNotes(exercises, exerciseId, exerciseNotesWithText);
          }
        });
      });

      if (options.onSuccess) {
        options.onSuccess(exerciseNotesWithText);
      }
    },
    meta: {
      name: 'useUpdateExerciseNote()',
      ...options.meta,
    },
  });
}

export function useDeleteExerciseNote(exerciseId, exerciseNoteId, options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: useDelete(`/training/exercises/${exerciseId}/notes/${exerciseNoteId}`),
    ...options,
    onSuccess: () => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['exercises'], exercises => {
          if (exercises) {
            return exercises.map(exercise =>
              exercise.id === exerciseId
                ? {
                    ...exercise,
                    notes: exercise.notes.filter(
                      exerciseNote => exerciseNote.id !== exerciseNoteId
                    ),
                  }
                : exercise
            );
          }
        });
      });

      if (options.onSuccess) {
        options.onSuccess();
      }
    },
    meta: {
      name: 'useDeleteExerciseNote()',
      ...options.meta,
    },
  });
}

// OTHER

export function useUserReview(options = {}) {
  return useGoodMutation({
    mutationFn: usePost('/userReview'),
    ...options,
    meta: {
      name: 'useUserReview()',
      ...options.meta,
    },
  });
}

export function useAttributionSurvey(options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost('/training/survey'),
    ...options,
    onSuccess: response => {
      runAfterAnimations(() => {
        queryClient.setQueryData(['user'], user => {
          return {
            ...user,
            attributes: response,
          };
        });
      });

      if (options.onSuccess) {
        options.onSuccess(response);
      }
    },
    meta: {
      name: 'useAttributionSurvey()',
      ...options.meta,
    },
  });
}

export function useTrackEvent(options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePost('/training/track'),
    ...options,
    onSuccess: newUserAttributes => {
      // NOTE: we don't care to wrap this in runAfterAnimations because this mutation is fire and
      // forget
      queryClient.setQueryData(['user'], oldUser => {
        if (oldUser) {
          return {...oldUser, attributes: newUserAttributes};
        }
      });

      if (options.onSuccess) {
        options.onSuccess(newUserAttributes);
      }
    },
    onError: (err, variables) => {
      // Log the error but don't present anything to the user
      logError(err, {extraData: variables, context: [this.meta?.name]});

      if (options.onError) {
        options.onError(err, variables);
      }
    },
    meta: {
      name: 'useTrackEvent()',
      ...options.meta,
    },
  });
}

export function useFeatureFlagMutation(options = {}) {
  const queryClient = useQueryClient();

  return useGoodMutation({
    mutationFn: usePut('/training/feature'),
    ...options,
    onSuccess: newUserAttributes => {
      queryClient.setQueryData(['user'], oldUser => {
        if (oldUser) {
          return {...oldUser, attributes: newUserAttributes};
        }
      });

      if (options.onSuccess) {
        options.onSuccess(newUserAttributes);
      }
    },
    onError: (err, variables) => {
      // Log the error but don't present anything to the user
      logError(err, {extraData: variables, context: [this.meta?.name]});

      if (options.onError) {
        options.onError(err, variables);
      }
    },
    meta: {
      name: 'useFeatureFlag()',
      ...options.meta,
    },
  });
}



The backend technology or architecture used by this application cannot be directly determined from the provided frontend code snippet. However, the use of `@tanstack/react-query` for data fetching, mutation, and state management suggests that the application interacts with a RESTful API or similar backend service. The `API_URL` constant, along with HTTP methods (`GET`, `POST`, `PUT`, `DELETE`), indicates that the application makes network requests to a server to fetch, create, update, and delete resources.

The backend could be implemented in any server-side technology that supports RESTful principles, such as Node.js with Express, Ruby on Rails, Django (Python), Spring Boot (Java), etc. The choice of backend technology depends on various factors including but not limited to scalability requirements, developer expertise, and specific project needs. Without specific details about the server-side implementation (e.g., server code, database schema), it's not possible to identify the exact backend technology used.


{
  "background_color": "red",
  "description": "Science is Stronger",
  "display": "standalone",
  "icons": [
    {
      "sizes": "512x512",
      "src": "/icon-512x512.png",
      "type": "image/png"
    },
    {
      "sizes": "180x180",
      "src": "/icon-180x180.png",
      "type": "image/png"
    }
  ],
  "id": "https://training.rpstrength.com/",
  "name": "RP Hypertrophy",
  "orientation": "portrait",
  "scope": "/",
  "short_name": "RP Hypertrophy",
  "start_url": "https://training.rpstrength.com/?v=0.22.12&token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6OTA0Mjc5LCJlbWFpbCI6InRAdGltd2hpdGUuY28iLCJyb2xlIjoidXNlciIsInJvbGVJZCI6NCwiZGlzcGxheU5hbWUiOiJUaW0gV2hpdGUiLCJjcmVhdGVkQXQiOiIyMDIyLTA5LTAxVDE3OjEyOjI5LjA0NloiLCJ1cGRhdGVkQXQiOiIyMDI0LTAyLTA4VDIwOjIyOjQ0Ljg3MVoiLCJpYXQiOjE3MDc1MTY2MjksImV4cCI6MTcyMzA2ODYyOX0.huR3KWgBGYe98xZZ4qLVu9qdVGrUo05jOozDmdRr1t4",
  "version": "0.22.12"
}


This JSON snippet describes a web app manifest for a progressive web application (PWA) called "RP Hypertrophy," associated with RP Strength (rpstrength.com). A web app manifest provides information about an application (such as name, author, icon, and description) in a JSON text file, allowing the web app to be installed on the user's device similarly to native apps. This manifest includes:

- **`background_color`**: Specifies the background color for the splash screen that appears while the app is launching. Here, it's set to `red`.
- **`description`**: A short description of the application, which is "Science is Stronger."
- **`display`**: Determines the preferred display mode for the application. `standalone` means the app will look like a native app with its own window.
- **`icons`**: Lists icons for the application, used on the home screen, app launcher, task switcher, etc. Two sizes are provided: 512x512 and 180x180 pixels.
- **`id`**: Represents a unique identifier for the web application. It's set to the URL of the app.
- **`name`**: The name of the web application, "RP Hypertrophy."
- **`orientation`**: Advises how the app prefers to be displayed in terms of screen orientation. This is set to `portrait`.
- **`scope`**: Defines the navigation scope of this web application which is set to root (`/`), meaning all navigation within this path is considered within the web app.
- **`short_name`**: A shorter name for the application, used where space is limited. Here, it's "RP Hypertrophy."
- **`start_url`**: The URL that loads when the app is launched. This URL includes a version number and a token, likely for session initialization or tracking purposes.
- **`version`**: Indicates the version of the web app, which is "0.22.12."

This manifest enables the "RP Hypertrophy" web app to be installed on a user's home screen on devices supporting PWAs, providing a more app-like experience.


breakdownt he tech stack based on everything shared above
