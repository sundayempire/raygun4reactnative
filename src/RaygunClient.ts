import { NativeModules, Platform } from 'react-native';
import { StackFrame } from 'react-native/Libraries/Core/Devtools/parseErrorStack';
import { getDeviceBasedId, filterOutReactFrames, cleanFilePath, noAddressAt } from './utils';
//@ts-ignore
const { version: clientVersion } = require('../package.json');
import {
  User,
  Session,
  CrashReportPayload,
  CustomData,
  RaygunClientOptions,
  BreadcrumbOption,
  Breadcrumb,
  RUMEvents
} from './types';
import { sendCustomRUMEvent, setupRealtimeUserMonitoring } from './realtime-user-monitor';
import { sendCrashReport, sendCachedReports } from './transport';

const { Rg4rn } = NativeModules;

const clone = <T>(object: T): T => JSON.parse(JSON.stringify(object));

const getCleanSession = (): Session => ({
  tags: new Set(['React Native']),
  customData: {},
  breadcrumbs: [],
  user: {
    identifier: `anonymous-${Rg4rn.DEVICE_ID}`
  }
});

const upperFirst = (obj: any | any[]): any | any[] => {
  if (Array.isArray(obj)) {
    return obj.map(upperFirst);
  }
  if (typeof obj === 'object') {
    return Object.entries(obj).reduce(
      (all, [key, val]) => ({
        ...all,
        ...(key !== 'customData'
          ? { [key.slice(0, 1).toUpperCase() + key.slice(1)]: upperFirst(val) }
          : { CustomData: val })
      }),
      {}
    );
  }
  return obj;
};

interface StackTrace {
  stack: StackFrame[];
}

let curSession = getCleanSession();
let GlobalOptions: RaygunClientOptions;

const getCurrentUser = () => curSession.user;

const init = async (options: RaygunClientOptions) => {
  GlobalOptions = Object.assign(
    {
      enableNetworkMonitoring: true,
      enableNativeCrashReporting: true,
      enableRUM: false,
      ignoreURLs: [],
      version: '',
      apiKey: ''
    },
    options
  );

  const canEnableNative =
    (GlobalOptions.enableNativeCrashReporting || GlobalOptions.enableRUM) && Rg4rn && typeof Rg4rn.init === 'function';

  const alreadyInitialized = canEnableNative && (await Rg4rn.hasInitialized());
  if (alreadyInitialized) {
    console.log('Already initialized');
    return false;
  }

  if (GlobalOptions.enableRUM) {
    if (!canEnableNative) {
      throw Error('Can not enable RUM as native sdk not configured properly');
    }
  }

  // Enable native side crash reporting
  if (canEnableNative) {
    const { version: appVersion, enableRUM, ignoreURLs, enableNetworkMonitoring, apiKey } = GlobalOptions;
    if (enableRUM) {
      setupRealtimeUserMonitoring(getCurrentUser, apiKey, enableNetworkMonitoring, ignoreURLs);
    }
    Rg4rn.init({ apiKey, enableRUM, version: appVersion || '' });
  }

  const prevHandler = ErrorUtils.getGlobalHandler();
  ErrorUtils.setGlobalHandler(async (error: Error, isFatal?: boolean) => {
    // TODO: doing RN side error reporting for now, will migrate to Rg4rn.sendMessage once raygun4apple is ready.
    await processUnhandledError(error, isFatal);
    prevHandler && prevHandler(error, isFatal);
  });

  const rejectionTracking = require('promise/setimmediate/rejection-tracking');
  rejectionTracking.disable();
  rejectionTracking.enable({
    allRejections: true,
    onUnhandled: processUnhandledRejection
  });
  if (!canEnableNative) {
    setTimeout(() => sendCachedReports(GlobalOptions.apiKey), 10);
  }
  return true;
};

const generatePayload = async (
  error: Error,
  stackFrames: StackFrame[],
  session: Session
): Promise<CrashReportPayload> => {
  const { breadcrumbs, tags, user, customData } = session;
  const environmentDetails = (Rg4rn.getEnvironmentInfo && (await Rg4rn.getEnvironmentInfo())) || {};
  return {
    OccurredOn: new Date(),
    Details: {
      Error: {
        ClassName: error?.name || '',
        Message: error?.message || '',
        StackTrace: stackFrames.map(({ file, methodName, lineNumber, column }) => ({
          FileName: file,
          MethodName: methodName || '[anonymous]',
          LineNumber: lineNumber,
          ColumnNumber: column,
          ClassName: `line ${lineNumber}, column ${column}`
        })),
        StackString: error?.toString() || ''
      },
      Environment: {
        UtcOffset: new Date().getTimezoneOffset() / 60.0,
        JailBroken: false,
        ...environmentDetails
      },
      Client: {
        Name: `raygun4reactnative.${Platform.OS}`,
        Version: clientVersion
      },
      UserCustomData: customData,
      Tags: [...tags],
      User: upperFirst(user),
      Breadcrumbs: upperFirst(breadcrumbs),
      Version: GlobalOptions.version || 'Not supplied'
    }
  };
};

const sendRUMTimingEvent = (
  eventType: RUMEvents.ActivityLoaded | RUMEvents.NetworkCall,
  name: string,
  timeUsedInMs: number
) => {
  if (!GlobalOptions.enableRUM) {
    console.warn('RUM is not enabled, please enable to use the sendRUMTimingEvent() function');
    return;
  }
  sendCustomRUMEvent(getCurrentUser, GlobalOptions.apiKey, eventType, name, timeUsedInMs);
};

const addTag = (...tags: string[]) => {
  tags.forEach(tag => {
    curSession.tags.add(tag);
  });
  if (GlobalOptions.enableNativeCrashReporting) {
    Rg4rn.setTags([...curSession.tags]);
  }
};

const setUser = (user: User | string) => {
  const userObj = Object.assign(
    { firstName: '', fullName: '', email: '', isAnonymous: false },
    typeof user === 'string'
      ? !!user
        ? {
            identifier: user
          }
        : {
            identifier: getDeviceBasedId(),
            isAnonymous: true
          }
      : user
  );
  if (GlobalOptions.enableNativeCrashReporting) {
    Rg4rn.setUser((curSession.user = userObj));
  }
};

const addCustomData = (customData: CustomData) => {
  curSession.customData = Object.assign({}, curSession.customData, customData);
  Rg4rn.setCustomData(clone(curSession.customData));
};

const updateCustomData = (updater: (customData: CustomData) => CustomData) => {
  curSession.customData = updater(curSession.customData);
  if (GlobalOptions.enableNativeCrashReporting) {
    Rg4rn.setCustomData(clone(curSession.customData));
  }
};

const recordBreadcrumb = (message: string, details?: BreadcrumbOption) => {
  const breadcrumb: Breadcrumb = {
    customData: {},
    category: '',
    level: 'info',
    message,
    ...details,
    timestamp: new Date().getTime()
  };
  curSession.breadcrumbs.push(breadcrumb);
  if (GlobalOptions.enableNativeCrashReporting) {
    Rg4rn.recordBreadcrumb(breadcrumb);
  }
};

const clearSession = () => {
  curSession = getCleanSession();
};

const processUnhandledRejection = (id: number, error: any) => processUnhandledError(error, false);

const processUnhandledError = async (error: Error, isFatal?: boolean) => {
  if (!error || !error.stack) {
    console.log('Unrecognized error occurred');
    return;
  }
  /** Following two module came from react flow source code, so we require here to prevent TS transpile it */
  const parseErrorStack = require('react-native/Libraries/Core/Devtools/parseErrorStack');
  const symbolicateStackTrace = require('react-native/Libraries/Core/Devtools/symbolicateStackTrace');
  const stackFrame = parseErrorStack(error);
  const cleanedStackFrames: StackTrace = __DEV__
    ? await symbolicateStackTrace(stackFrame)
    : { stack: cleanFilePath(stackFrame) };

  const stack = cleanedStackFrames.stack || [].filter(filterOutReactFrames).map(noAddressAt);

  if (isFatal) {
    curSession.tags.add('Fatal');
  }

  const payload = await generatePayload(error, stack, curSession);
  const { onBeforeSend } = GlobalOptions;
  const shouldSkip = onBeforeSend && typeof onBeforeSend === 'function' && !onBeforeSend(Object.freeze(payload));

  if (shouldSkip) {
    return;
  }
  console.log('enableNativeCrashReporting', GlobalOptions.enableNativeCrashReporting);
  if (GlobalOptions.enableNativeCrashReporting) {
    console.log('Send crash report via Native');
    Rg4rn.sendCrashReport(JSON.stringify(payload), GlobalOptions.apiKey);
  } else {
    console.log('Send crash report via JS');
    await sendCrashReport(payload, GlobalOptions.apiKey);
  }
};

export {
  init,
  addTag,
  setUser,
  addCustomData,
  clearSession,
  updateCustomData,
  recordBreadcrumb,
  filterOutReactFrames,
  noAddressAt,
  generatePayload,
  sendRUMTimingEvent
};
