#!/usr/bin/node

/****************************************************************************************

	Aria entry point
	
	This includes the list of Node modules to include. It also creates a few top-level
	variables used throughout the application. This must be concatenated first when
	generating the application. (The grunt configuration currently does this.)
	
****************************************************************************************/
import fs from "fs";

import url from "url";
import md5 from "md5";
import http from "http";
import path from "path";
import util from "util";
import redis from "redis";
import flite from "flite";
import parser from "xmldoc";
import uuid from "node-uuid";
import ari from "ari-client";
import express from "express";
import fetch from "node-fetch";
import download from "download";
import formdata from "form-data";

import * as Promise from "bluebird";

import ariaConfig from "./config/aria.conf.js";

const twimlActions = {};
const rc = redis.createClient(); /**************************************************************************************

    Aria Call Object
    
    Contains the constructor for Aria call objects. Also includes a set of top-level
    convenience functions for fetching Twiml and generating a linked list of
    actions to process. 

    TODO: In reality Aria could handle any number of other script formats. Twiml is
    convenient because there are already libraries out there that generate it. At
    some point in the future it would be fun to wrap up the twiml-specific bits in
    a node module and make the interpreter generic, such that you could use other
    inputs - perhaps a JSON-based script - to drive the Aria engine.
    
**************************************************************************************/

const makeAction = ({ name, val, attr, children }, parent) => {
  const action = {};

  action.name = name;

  // console.log(`Input Object: ${util.inspect(xml)}`);
  console.log(
    `Running Action '${name}' With Text Value '${val}' | Child length: ${children.length}.`
  );

  action.value = val.trim();
  action.parameters = attr;
  action.call = parent;
  action.next = null;
  action.children = null;

  let lastChild = null;
  if (children && children.length > 1) {
    for (let i = 0; i < children.length; i = i + 1) {
      const x = children[i];
      console.log(`Calling makeAction on Child: ${util.inspect(x)}`);
      const a = makeAction(x, parent);
      if (!action.children) {
        action.children = a;
        lastChild = a;
      } else {
        lastChild.next = a;
        lastChild = a;
      }
    }
    lastChild.next = null;
  }

  return action;
};

// make subsequent requests, optionally passing back data
const fetchTwiml = (method, twimlURL, call, data) => {
  console.log(`Fetching Twiml From: ${twimlURL}`);

  const options = {
    method: method || "POST",
    body: data || null
  };

  const elements = url.parse(twimlURL);
  if (!elements.protocol) {
    twimlURL = url.resolve(call.baseUrl, twimlURL);
  }

  fetch(twimlURL, options)
    // JE: This XML parser is quite dumb about carriage returns from web servers, so forcibly kill them all
    .then(res => res.text())
    .then(twiml => {
      // Consider refactoring this, but for now, forcibly ensures node insertions
      // are not improperly considered due to "hard" whitespace
      twiml = twiml.replace(/(\r\n|\n|\r)/gm, "");
      twiml = twiml.replace(/>\s*/g, ">"); // Replace "> " with ">"
      twiml = twiml.replace(/\s*</g, "<"); // Replace "< " with "<"

      // create the linked list of actions to execute
      const first = null;
      let last = null;

      // wipe out the old stack
      call.stack = null;

      console.log(`XML Body: ${twiml}`);

      // parse the xml and create a new stack
      const xml = new parser.XmlDocument(twiml);
      xml.eachChild((command, index, { length }) => {
        // console.log(`Initial command is ${command} with call ${util.inspect(call)}`);
        console.log(`Initial command is ${command}`);

        const action = makeAction(command, call);

        if (!call.stack) {
          call.stack = action;
          last = action;
        } else {
          last.next = action;
          last = action;
        }
        if (index === length - 1) {
          last.next = null;
          console.log(`Processing call...`);
          call.processCall();
        }
      });
    });
};

// load up a form data object with standard call parameters
const setCallData = ({ sid, from, to, status }, form) => {
  form.append("CallSid", sid);
  form.append("AccountSid", "aria-call"); // perhaps use local IP or hostname?
  form.append("From", from);
  form.append("To", to);
  form.append("CallStatus", status);
  form.append("ApiVersion", "0.0.1");
  form.append("Direction", "inbound"); // TODO: fix this to reflect actual call direction
  form.append("ForwardedFrom", ""); // TODO: fix this too
  form.append("CallerName", ""); // TODO: and this
};

class AriaCall {
  constructor(client, channel, url, twiml, done) {
    const that = this;

    this.client = client; // a reference to the ARI client
    this.baseUrl = url; // the base URL from whence the Twiml was fetched
    this.stack = null; // the call stack

    this.originatingChannel = channel; // the channel that originated the call (incoming)
    this.dialedChannel = null; // the dialed channel (if any) for the call

    this.channel = this.originatingChannel; // the active channel object for the call

    this.playback = null; // the placeholder for an active playback object
    this.stopOnTone = false; // should the playback be stopped when a tone is received?

    this.digits = "";
    this.digitTimer = null; // timer used to wait for digits;
    this.maxDigits = 0; // maximum number of digits to collect
    this.termDigit = "#"; // digit used to signal end of collection
    this.digitCallback = null; // callback on digit collection

    this.hungup = false; // hangup flag
    this.hangupCallback = null; // callback on hangup

    this.from = channel.caller.number;
    this.to = "";
    this.createTime = new Date().getTime();
    this.status = "Awesome";

    this.sid = uuid.v4();

    // advance to the next action in the list
    this.advancePointer = () => {
      if (that.stack.next) {
        that.stack = that.stack.next;
        that.processCall();
      } else {
        that.terminateCall();
      }
    };

    channel.on("ChannelDtmfReceived", ({ digit }, { id }) => {
      console.log(`Channel ${id} - Digit: ${digit}`);
      that.digits += digit;
      if (that.digitCallback) {
        that.digitCallback(digit, that.digits);
      }
    });

    channel.on("ChannelHangupRequest", (evt, { id }) => {
      console.log(`Channel ${id} - Hangup Request`);
      that.hungup = true;
      if (that.hangupCallback) {
        that.hangupCallback();
      }
    });

    // fetch the Twiml for this call

    console.log(`Initial TwiML Request GET to ${url}`);
    fetchTwiml("GET", url, that, null);
  }

  processCall() {
    const command = this.stack;
    const action = twimlActions[command.name];
    if (!action) {
      console.log(`Invalid or improper command: ${command.name}`);
      this.terminateCall();
    } else {
      action(command, command.call.advancePointer);
    }
  }

  terminateCall() {
    // post the call record to the account's call history URI if set;
    // do other post-call stuff here
    const milliseconds = new Date().getTime();
    console.log(
      `Channel ${this.channel.id} - Call duration: ${milliseconds -
        this.createTime}ms`
    );
    if (!this.hungup) {
      try {
        this.channel.hangup();
      } catch (e) {
        // must have already hung up
      }
    }
  }
} /**************************************************************************************

    Aria Answer action
    
    Explicitly move the call to an offhook state.
    
    Note: This is not a part of the Twilio Twiml spec. It is my own addition to allow
    for somewhat finer-grained control over the call.

**************************************************************************************/

twimlActions.Answer = (command, callback) => {
  const call = command.call;
  const channel = call.channel;
  const client = call.client;
  const playback = null;

  console.log(`Channel ${channel.id} - Dialing: ${command.value}`);

  setTimeout(() => {
    if (call.hungup) {
      return call.terminateCall();
    } else {
      channel.answer();
      return callback();
    }
  }, 0);
}; /**************************************************************************************

    Aria Say action
    
    Play back synthesized speech using the Flite TTS engine.
    
    This is a bit of a hack in that ARI currently has no support for TTS. It works
    by using the free Flite TTS engine to render audio files which are then cached
    and re-used. This leads to a slight but noticeable delay when using "Say" for 
    the first time for a given word or phrase.
    
    Parameters
    
    voice: The actual Twilio engine allows you to set "man", "woman" or "alice" which
    seems to invoke a more capable TTS engine with support for multiple languages.
    
    loop: the number of times to play the audio file. Default is 1. If the value is
    set to 0, the file will be played indefinitely until the call is hung up.
    
    language: 
    
    termDigits: a string containing a list of DTMF digits that will result in the
    playback being cancelled. NOTE: not a part of the Twilio Twiml spec.
    
    Nested Verbs
    
    Verbs may not be nested within the Say command. The Say command, however, may be
    nested in the Gather verb.

**************************************************************************************/

twimlActions.Say = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Say: ${command.value}`);

  // attach a handler function for digits
  call.digitCallback = (digit, digits) => {
    if (playback) {
      if (
        command.parameters.termDigits &&
        command.parameters.termDigits.indexOf(digit) > -1
      ) {
        playback.stop();
      }
    }
  };

  var play = (sound, done) => {
    playback = client.Playback();
    playback.on("PlaybackFinished", (event, cp) => {
      playback = null;
      if (done) {
        done();
      }
    });
    channel.play(
      {
        media: `sound:${sound}`
      },
      playback
    );
  };

  function synth() {
    //  kal awb_time kal16 awb rms slt
    var options = {
      voice: "slt"
    };
    flite(options, (err, speech) => {
      if (err) {
        exit();
      } else {
        speech.say(command.value, `${fileName}.wav16`, err => {
          if (err) {
            exit();
          } else {
            play(fileName, exit);
          }
        });
      }
    });
  }

  function exit() {
    if (call.hungup) {
      return call.terminateCall();
    } else {
      return callback();
    }
  }

  if (!command.value) {
    console.log(
      `Channel ${channel.id} - ERROR: No text value provided in 'Say' request.`
    );
    exit();
    return;
  }

  var hashName = md5(command.value);
  var fileName = path.join(ariaConfig.audioPath, hashName);

  fs.exists(fileName, exists => {
    if (exists) {
      play(hashName, exit);
    } else {
      synth();
    }
  });
}; /**************************************************************************************

    Aria 'Play' action
    
    Play back recorded audio from a provided URL.
    
    Value (CDATA): 
    
    The URL for the audio file to play. Must be in a file format and include an
    extension that Asterisk recognizes. (.slin, .wav, .WAV, .wav16, .gsm).
    
    The URL may be either a fully qualified URI (i.e. includes the protocol and full
    path) or a relative value. If the URL does not start with a protocol (i.e. 'http'
    or 'https') then it is treated as relative and resolved using the base URL for
    the Twiml block.
    
    Parameters
    
    loop: the number of times to play the audio file. Default is 1. If the value is
    set to 0, the file will be played indefinitely until the call is hung up.
    
    digits: a string of digits (DTMF tones) to play. If the digits parameter is set,
    the CDATA value is optional. Acceptable values are 0 - 9, * and #.
    
    termDigits: a string containing a list of DTMF digits that will result in the
    playback being cancelled. NOTE: not a part of the Twilio Twiml spec.
    
    Notes
    
    At this point the file is fetched every time. This needs to change. In a proper
    solution the file will be cached and an eTag header will be retained (probably in
    Redis) that can be sent along with the download request.

**************************************************************************************/

twimlActions.Play = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Playing: ${command.value}`);

  // attach a handler function for digits
  call.digitCallback = (digit, digits) => {
    if (playback) {
      if (
        command.parameters.termDigits &&
        command.parameters.termDigits.indexOf(digit) > -1
      ) {
        playback.stop();
      }
    }
  };

  // play back the sound file
  var play = (sound, done) => {
    playback = client.Playback();
    playback.on("PlaybackFinished", (event, cp) => {
      playback = null;
      if (done) {
        done();
      }
    });
    channel.play(
      {
        media: `sound:${sound}`
      },
      playback
    );
  };

  // exit, calling the provided callback
  var exit = () => {
    if (call.hungup) {
      return call.terminateCall();
    } else {
      return callback();
    }
  };

  // get the file URL
  var fileURL = url.parse(command.value);
  var fileHash = null;

  // TODO: Add in support for playing back values in the standard voice
  // NONSTANDARD - ASTERISK ONLY
  if (command.parameters.type) {
    if (command.parameters.type === "number") {
      // read a number as a number (i.e. 3192 = "three thousands, one hundred and ninety-two")
    } else if (command.parameters.type === "digits") {
      // read a number as a string of digits (i.e. 1947 = "one", "nine", "four", "seven")
    } else if (command.parameter.type === "date") {
      // lots of subtype options here - perhaps this needs a default and a format map... dateFormat?
      // read a unix timestamp value (seconds) as a date
      // i.e. "1446047333" = "Wednesday, October Twenty Fifth, Two Thousand Fifteen"
    } else if (command.parameter.type === "time") {
      // again, all kinds of local format stuff to deal with here... timeFormat?
      // read a unix timestamp value (seconds) as a time
      // i.e. "1446047333" = "Three", "Forty", "Eight", "P", "M", "G", "M", "T"
    } else if (command.parameters.type === "money") {
      // need to add support for multiple currencies
      // read a number as a monetary amount. (i.e. 129.95 = "one hundred and twenty-nine dollars and ninety-five cents")
    } else if (command.parameters.type === "alpha") {
      // read a string as a list of characters (i.e. "Hello World" = "H", "E", "L", "L", "O", "space", "W", "O", "R", "L", "D")
    } else if (command.parameters.type === "phonetic") {
      // read a string using ICAO phonetics (i.e. CB239 = "Charlie", "Bravo", "Two", "Tree", "Niner")
    } else {
      // ignore - not a supported format
    }
  }

  // if it does not have a protocol it must be relative - resolve it
  if (!fileURL.protocol) {
    var resolved = url.resolve(call.baseUrl, command.value);
    fileURL = url.parse(resolved);
  }

  // generate a hash which we will use as the filename
  var hashName = md5(fileURL.href);
  var fileName = hashName + path.extname(fileURL.href);

  // create a downloader object and fetch the file
  var dl = new download({
    mode: "755"
  });
  dl.get(fileURL.href)
    .dest(ariaConfig.audioPath)
    .rename(fileName)
    .run((err, files) => {
      if (err) {
        console.log(
          `Channel ${channel.id} - ERROR: Unable to download requested file.`
        );
        console.error(err);
        exit();
      } else {
        play(hashName, exit);
      }
    });
}; /**************************************************************************************

    Aria Gather action
    
    Collect digits, optionally playing prompts to the caller. On completion,
    submit the digits (along with standard call data) to the provided 'action'
    URL.
    
    Parameters
    
    Nested Elements
    
**************************************************************************************/

twimlActions.Gather = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;

  console.log(`Channel ${channel.id} - Gathering: ${command.value}`);

  var timeout = command.parameters.timeout || 5;
  var timer = null;

  // clear the digit buffer?
  if (command.parameters.clear !== "false") {
    call.digits = "";
  }

  // set the max digits and terminator values
  call.maxDigits = parseInt(command.parameters.numDigits, 10) || 0;
  call.termDigit = command.parameters.finishOnKey || "#";

  var collectDigits = () => {
    // if the buffer already has enough we can move on...
    if (call.maxDigits > 0 && call.digits.length >= call.maxDigits) {
      return doneCollecting();
    }

    // otherwise set a callback for digit events
    call.digitCallback = (digit, { length }) => {
      if (digit === call.termDigit) {
        // done - received term digit;
        doneCollecting();
      } else if (call.maxDigits > 0 && length >= call.maxDigits) {
        // done - hit max length
        doneCollecting();
      }
    };

    call.hangupCallback = () => {
      doneCollecting();
    };

    // and set the timer for our timeout
    timer = setTimeout(doneCollecting, timeout * 1000);
  };

  var doneCollecting = digits => {
    call.digitCallback = null;
    call.hangupCallback = null;

    // snapshot as the buffer could change
    var returnDigits = call.digits;
    call.digits = "";

    console.log(
      `Channel ${channel.id} - Done gathering. Collected: ${returnDigits}`
    );

    // clear the timer
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    // bail if the call has been hung up
    if (call.hungup) {
      return call.terminateCall();
    }

    // If the user entered any digits, use the action / method parameters
    // to send the value to the user's server
    if (returnDigits.length > 0) {
      // send digits to the server, get next XML block
      var method = command.parameters.method || "POST";
      var url = command.parameters.action || call.baseUrl;
      var form = new formdata();
      setCallData(call, form);
      form.append("Digits", returnDigits);
      return fetchTwiml(method, url, call, form);
    } else {
      // fail - continue on to the next action
      return callback();
    }
  };

  // THIS IS THE NESTED COMMAND HANDLER - CAN THIS BE MADE GENERIC????
  // var nccb = function() {
  //     next child logic here
  // }
  // runNestedCommands(command, nccb, function() {
  //     // do the next thing (collect, record, etc.)
  // });
  // if there are embedded play or say commands, execute them

  var child = command.children;

  // run the nested child action if it is valid
  var runChild = () => {
    // bail if the call has been hung up
    if (call.hungup) {
      return call.terminateCall();
    }

    // move past any verbs other than Play or Say
    while (child && child.name !== "Play" && child.name !== "Say") {
      console.log(
        `Channel ${channel.id} - Invalid nested verb: ${child.name}. Skipped`
      );
      child = child.next;
    }
    if (child) {
      var action = twimlActions[child.name];
      child.parameters.termDigits = "1234567890*#"; // any key will terminate input
      child.parameters.clear = false; // do not allow the Play or Say command to clear the buffer
      action(child, nextChild);
    } else {
      collectDigits();
    }
  };

  // move the pointer to the next child and play it, otherwise start gathering
  var nextChild = () => {
    if (child.next && call.digits.length === 0) {
      child = child.next;
      runChild();
    } else {
      collectDigits();
    }
  };

  // if the gather verb has nested children, execute them. otherwise collect digits
  if (child) {
    runChild();
  } else {
    collectDigits();
  }
}; /**************************************************************************************

    Aria Pause action
    
    Wait for a number of seconds

**************************************************************************************/

twimlActions.Pause = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Pausing: ${command.parameters.length}`);

  var timer = null;
  var value = parseInt(command.parameters.length, 10);

  call.hangupCallback = () => {
    if (timer) {
      clearTimeout(timer);
      call.hangupCallback = null;
    }
  };

  // set a timer and wait
  timer = setTimeout(() => {
    console.log(`Channel ${channel.id} - Pause complete`);
    if (call.hungup) {
      return call.terminateCall();
    } else {
      return callback();
    }
  }, value * 1000);
}; /**************************************************************************************

    Aria Record action
    
    Record audio from the caller. Store it and post the URL to the server. Expect
    additional instructions.

**************************************************************************************/

twimlActions.Record = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  // set the maximum length the recording can last - default one hour
  var maxTime = command.parameters.maxLength
    ? parseInt(command.parameters.maxLength, 10)
    : 3600;

  // do we play a beep?
  var playBeep = command.parameters.playBeep === "false" ? false : true;

  // terminate recording on which tones?
  var finishOnKey = command.parameters.finishOnKey || "any";

  call.hangupCallback = () => {
    console.log("Call hung up!");
  };

  var fname = uuid.v4();

  // log the start
  console.log(`Channel ${channel.id} - Recording: ${fname}.wav`);

  // create parameters for the recording
  var params = {
    beep: playBeep,
    channelId: channel.id,
    format: "wav",
    ifExists: "overwrite",
    maxDurationSeconds: maxTime,
    maxSilenceSeconds: 60,
    name: fname,
    terminateOn: "#"
  };

  // start the recording process
  var recordStartTime = new Date().getTime();

  channel.record(params, (err, recording) => {
    if (err) {
      console.log(`Error starting recording: ${err.message}`);
      return call.termiateCall();
    }

    recording.on("RecordingStarted", (event, rec) => {
      console.log(`Channel ${channel.id} - Started recording`);
    });

    recording.on("RecordingFailed", (event, rec) => {
      console.log(`Channel ${channel.id} - Recording Failed`);
      console.dir(event);
      return callback();
    });

    recording.on("RecordingFinished", (event, rec) => {
      var recordEndTime = new Date().getTime();
      console.log(`Channel ${channel.id} - Finished recording`);

      // send digits to the server, get next XML block
      var method = command.parameters.method || "POST";
      var url = command.parameters.action || call.baseUrl;
      var form = new formdata();
      setCallData(call, form);
      // TODO: assemble the same basic data that Twilio provides

      // Now create the URL for this file so it can be played
      var local_uri = `recording:${fname}`;
      form.append("RecordingUri", local_uri);
      form.append("RecordingURL", `${ariaConfig.serverBaseUrl + fname}.wav`);
      form.append("RecordingDuration", recordEndTime - recordStartTime);
      form.append("Digits", call.digits);
      return fetchTwiml(method, url, call, form);
    });
  });
}; /**************************************************************************************

    Aria Dial action
    
    Call a phone number, WebRTC client, SIP destination, conference or queue.
    
    FOR THE MOMENT: We only support a PSTN phone number in the CDATA value of the Dial
    verb. The next step will be to add support for multiple destinations, and
    non-PSTN destinations.
    
    <Number>18168068844</Number>
		For calling phone numbers. Note that the CDATA value (raw text inside the <Dial>
		and </Dial> tags) can be used to call a single phone number.
		
    <Sip>foobar@sip.foobar.com</Sip>
    For calling raw SIP URIs. TODO.
        
    <Client @app="long-guid-string-here">ssokol@digium.com</Client>
    For calling Respoke endpoints. Add in an "app" parameter to call something other
    than the default app configured in /etc/asterisk/aria.conf.js
    
    <Conference>Emperor</Conference>
    In the real Twilio this presumably results in an outbound call to a conference
    resource where the actual conf_bridge session is run. In this case we simply
    use a local named bridge.
    
    <Queue>Sales Main</Queue>
    In the real Twilio this presumably results in an outbound call to a queue resource
    where the actual queueing system runs. In this case we simply redirect the call to
    a queue. (May actually use "ContinueInDialplan" here as creating a complete queueing
    system is out of scope for Aria.)

**************************************************************************************/

twimlActions.Dial = (command, callback) => {
  var call = command.call;
  var originalChannel = call.channel;
  var dialedChannel = null;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${call.channel.id} - Dialing: ${command.value}`);

  var originate = (channel, destination, callerId) => {
    var dialed = client.Channel();
    call.dialedChannel = dialed;

    dialed.on("StasisStart", (event, dialed) => {
      if (command.parameters.bridge && command.parameters.bridge === "false") {
        // automatic bridging of the channels is disabled

        dialed.on("StasisEnd", (event, dialed) => {
          // dialedExit(dialed, bridge);
          console.log("Stasis End On Dialed Channel");
        });

        dialed.answer(err => {
          if (err) {
            throw err; // TODO: trap and handle this.
          }
          console.log(
            "Channel %s - Dialed channel %s has been answered.",
            channel.id,
            dialed.id
          );

          // make the dialed call the active call
          call.channel = dialed;

          // continue executing with the action
          var method = command.parameters.method || "POST";
          var url = command.parameters.action || call.baseUrl;
          var form = new formdata();
          setCallData(call, form);
          return fetchTwiml(method, url, call, form);
        });
      } else {
        // rather than registering another handler, perhaps this should hook the active
        // handler provided by the call object?
        channel.on("StasisEnd", (event, channel) => {
          hangupDialed(channel, dialed);
        });

        dialed.on("ChannelDestroyed", (event, dialed) => {
          hangupOriginal(channel, dialed);
        });

        joinMixingBridge(channel, dialed);
      }
    });

    dialed.originate(
      {
        endpoint: destination,
        app: "aria",
        callerId,
        appArgs: "dialed"
      },
      (err, dialed) => {
        if (err) {
          console.log(
            `Channel ${channel.id} - Error originating outbound call: ${err.message}`
          );
          return callback();
        }
      }
    );
  };

  // handler for original channel hanging. gracefully hangup the dialed channel
  var hangupDialed = ({ id }, dialed) => {
    console.log(
      "Channel %s - Channel has left the application. Hanging up dialed channel %s",
      id,
      dialed.id
    );

    // hangup the other end
    dialed.hangup(err => {
      // ignore error since dialed channel could have hung up, causing the
      // original channel to exit Stasis
    });
  };

  // handler for dialed channel hanging up.
  var hangupOriginal = (channel, { id }) => {
    console.log(
      "Channel %s - Dialed channel %s has been hung up.",
      channel.id,
      id
    );

    // hangup the original channel
    channel.hangup(err => {
      // ignore error since original channel could have hung up, causing the
      // dialed channel to exit Stasis
    });
  };

  // handler for dialed channel entering Stasis
  var joinMixingBridge = (channel, dialed) => {
    var bridge = client.Bridge();

    dialed.on("StasisEnd", (event, dialed) => {
      dialedExit(dialed, bridge);
    });

    dialed.answer(err => {
      if (err) {
        throw err; // TODO: trap and handle this.
      }
      console.log(
        "Channel %s - Dialed channel %s has been answered.",
        channel.id,
        dialed.id
      );
    });

    bridge.create(
      {
        type: "mixing"
      },
      (err, bridge) => {
        if (err) {
          throw err; // TODO: trap and handle this.
        }

        console.log("Channel %s - Created bridge %s", channel.id, bridge.id);

        addChannelsToBridge(channel, dialed, bridge);
      }
    );
  };

  // handler for the dialed channel leaving Stasis
  var dialedExit = ({ name }, bridge) => {
    console.log(
      "Channel %s - Dialed channel %s has left our application, destroying bridge %s",
      call.channel.id,
      name,
      bridge.id
    );

    bridge.destroy(err => {
      if (err) {
        throw err;
      }
    });
  };

  // handler for new mixing bridge ready for channels to be added to it
  var addChannelsToBridge = ({ id }, bridge) => {
    console.log(
      "Channel %s - Adding channel %s and dialed channel %s to bridge %s",
      id,
      id,
      id,
      bridge.id
    );

    bridge.addChannel(
      {
        channel: [id, id]
      },
      err => {
        if (err) {
          throw err;
        }
      }
    );
  };

  call.to = command.value;
  var dest = `${ariaConfig.trunk.technology}/${command.value}@${ariaConfig.trunk.id}`;
  console.log(
    `Channel ${originalChannel.id} - Placing outbound call to: ${dest}`
  );
  var cid = command.parameters.callerId || "";
  originate(call.channel, dest, cid);
}; /**************************************************************************************

    Aria Bridge action
    
    Bridge two legs together in a call. Assumes that there are valid values for
    call.originatingChannel and call.dialedChannel.

**************************************************************************************/

twimlActions.Bridge = (command, callback) => {
  var call = command.call;
  var client = call.client;

  console.log(`Channel ${call.originatingChannel.id} - Bridge`);

  // handler for original channel hanging. gracefully hangup the dialed channel
  var hangupDialed = ({ id }, dialed) => {
    console.log(
      "Channel %s - Channel has left the application. Hanging up dialed channel %s",
      id,
      dialed.id
    );

    // hangup the other end
    dialed.hangup(err => {
      // ignore error since dialed channel could have hung up, causing the
      // original channel to exit Stasis
    });
  };

  // handler for dialed channel hanging up.
  var hangupOriginal = (channel, { id }) => {
    console.log(
      "Channel %s - Dialed channel %s has been hung up.",
      channel.id,
      id
    );

    // hangup the original channel
    channel.hangup(err => {
      // ignore error since original channel could have hung up, causing the
      // dialed channel to exit Stasis
    });
  };

  // handler for dialed channel entering Stasis
  var joinMixingBridge = (channel, dialed) => {
    var bridge = client.Bridge();

    dialed.on("StasisEnd", (event, dialed) => {
      dialedExit(dialed, bridge);
    });

    dialed.answer(err => {
      if (err) {
        throw err; // TODO: trap and handle this.
      }
      console.log(
        "Channel %s - Dialed channel %s has been answered.",
        channel.id,
        dialed.id
      );
    });

    bridge.create(
      {
        type: "mixing"
      },
      (err, bridge) => {
        if (err) {
          throw err; // TODO: trap and handle this.
        }

        console.log("Channel %s - Created bridge %s", channel.id, bridge.id);

        addChannelsToBridge(channel, dialed, bridge);
      }
    );
  };

  // handler for the dialed channel leaving Stasis
  var dialedExit = ({ name }, bridge) => {
    console.log(
      "Channel %s - Dialed channel %s has left our application, destroying bridge %s",
      call.channel.id,
      name,
      bridge.id
    );

    bridge.destroy(err => {
      if (err) {
        throw err;
      }
    });
  };

  // handler for new mixing bridge ready for channels to be added to it
  var addChannelsToBridge = ({ id }, bridge) => {
    console.log(
      "Channel %s - Adding channel %s and dialed channel %s to bridge %s",
      id,
      id,
      id,
      bridge.id
    );

    bridge.addChannel(
      {
        channel: [id, id]
      },
      err => {
        if (err) {
          throw err;
        }
      }
    );
  };

  // rather than registering another handler, perhaps this should hook the active
  // handler provided by the call object?
  call.originatingChannel.on("StasisEnd", (event, channel) => {
    hangupDialed(channel, call.dialedChannel);
  });

  call.dialedChannel.on("ChannelDestroyed", (event, dialed) => {
    hangupOriginal(call.originatingChannel, dialed);
  });

  joinMixingBridge(call.originatingChannel, call.dialedChannel);
}; /**************************************************************************************

    Aria Hold action
    
    Hold the active call leg.

**************************************************************************************/

twimlActions.Hold = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;
  var bridge = null;

  console.log(`Channel ${channel.id} - Hold`);

  // find or create a holding bridge

  client.bridges.list((err, bridges) => {
    if (err) {
      throw err;
    }

    bridge = bridges.filter(({ bridge_type }) => bridge_type === "holding")[0];

    if (bridge) {
      console.log(util.format("Using bridge %s", bridge.id));
      start();
    } else {
      client.bridges.create({ type: "holding" }, (err, newBridge) => {
        if (err) {
          throw err;
        }
        bridge = newBridge;
        console.log(util.format("Created bridge %s", bridge.id));
        start();
      });
    }
  });

  // continue the call on the next tick
  var start = () => {
    setTimeout(() => {
      bridge.addChannel({ channel: channel.id }, err => {
        if (err) {
          throw err;
        }

        bridge.startMoh(err => {
          if (err) {
            throw err;
          }
          return callback();
        });
      });
    }, 0);
  };
}; /**************************************************************************************

    Aria Unhold action
    
    Unhold a held call leg.

**************************************************************************************/

twimlActions.Unhold = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Hold`);

  // continue the call on the next tick
  setTimeout(() => callback(), 0);
}; /**************************************************************************************

    Aria Reject action
    
    Reject a call.

**************************************************************************************/

twimlActions.Reject = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Reject`);

  // terminate the call on the next tick
  setTimeout(() => call.terminateCall(), 0);
}; /**************************************************************************************

    Aria Hangup action
    
    End a call.

**************************************************************************************/

twimlActions.Hangup = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Hangup`);

  // terminate the call on the next tick
  setTimeout(() => {
    call.hungup = true;
    channel.hangup();
    return call.terminateCall();
  }, 0);
}; /**************************************************************************************

    Aria Redirect action
    
    Instruct Aria to fetch new instructions from a server and continue processing
    with the result.

**************************************************************************************/

twimlActions.Redirect = (command, callback) => {
  var call = command.call;
  var channel = call.channel;
  var client = call.client;
  var playback = null;

  console.log(`Channel ${channel.id} - Redirect: ${command.value}`);

  // TODO: implement SMS message send

  // go on to the next action
  setTimeout(() => {
    try {
      var method = command.parameters.method || "POST";
      var redirectURL = null;
      if (command.value) {
        var parts = url.parse(command.value);
        if (parts.protocol) {
          redirectURL = command.value;
        } else {
          redirectURL = url.resolve(call.baseUrl, command.value);
        }
      } else {
        redirectURL = call.baseUrl;
      }
      var form = new formdata();
      setCallData(call, form);
      return fetchTwiml(method, redirectURL, call, form);
    } catch (e) {
      return callback();
    }
  }, 0);
}; /**************************************************************************************

	Aria Call Processor - Main Module

	This section of the overall Aria application creates a connection to the Asterisk
	server and serves as the entry point for incoming call requests signaled by the
	ARI "StasisStart" event.
	
	Configuration
	
	You will need to have Asterisk 13, Redis, and Node.js installed to run Aria.
	
	Configuration data is pulled from the 'aria.conf.js' file in the Asterisk directory 
	(/etc/asterisk). This file needs to export the values for the host, username and
	password as follows:
	
	exports.asterisk = [ip or host name / port]
	exports.username = [ARI user name from ari.conf]
	exports.password = [ARI password from ari.conf]
	
	The application starts, connects with Asterisk and registers an ARI application 
	called "aria". Your diplan needs to route calls to the aria application.
	
	    [aria-app]
	    exten => _X.,1,NoOp(Sending call into 'aria' application)
	         same => n,Stasis(aria)
	         same => n,Hangup     
	
	When a call arrives, Aria looks up the dialed number (${EXTEN}) in Redis. It expects
	a hash structure stored using a key that looks like:
	
	    /numbers/[number]
	
	This should return a hash structure with an "method" key and a "url" key. The
	"method" key should contain a string with either "GET" or "POST" in it. The 
	"url" key should include a fully qualified URL pointing to the application or raw
	Twiml script to execute.
	
	See the README.md file or the wiki for more information on configuring Aria.
	
**************************************************************************************/

(() => {
  let rc = null;

  // initialize local http server for recorded files
  const recApp = express();
  recApp.use(express.static(ariaConfig.recordingPath));

  console.log(`Serving static files in /ml for ${ariaConfig.mlPath}`);
  recApp.use("/ml", express.static(ariaConfig.mlPath));

  const recServer = http.createServer(recApp);
  recServer.listen(ariaConfig.recordingPort);
  // TODO: make this secure, at least to some degree

  // initialize stasis / ARI
  function clientLoaded(err, client) {
    if (err) {
      throw err;
    }

    // handler for StasisStart event
    function stasisStart(event, channel) {
      if (event.args[0] === "dialed") {
        console.log("Ignoring dialed call leg.");
        return;
      }

      console.log(
        util.format("Channel %s - Entered the application", channel.id)
      );

      // figure out what technology is in use so we know what to use for routing
      const ctype = event.channel.name.split("/")[0];

      // SIP Client Call
      if (ctype === "SIP" || ctype === "PJSIP") {
        // Route the call based on dialed Number
        let number = channel.dialplan.exten;

        // Replace the number with the value of arg[0] if present - FOR TESTING
        if (event.args[0]) {
          number = event.args[0];
        }

        // Query redis for the assigned url
        const lookup = `/numbers/${number}`;
        const app = rc.hgetall(lookup, (err, value) => {
          if (err || !value) {
            // log the error to the appropriate facility
            // respond with a tri-tone error on the line
          } else {
            // fetch the Twiml from the provided url
            console.log(`Initiating new Aria application on ${number}`);
            const call = new AriaCall(client, channel, value.url);
          }
        });
      }

      // Respoke Client Call
      else if (ctype === "RESPOKE") {
        // TODO - Handle Respoke Calls
      }
    }

    // handler for StasisEnd event
    function stasisEnd(event, { id }) {
      console.log(util.format("Channel %s - Left the application", id));
    }

    // create a redis client
    rc = redis.createClient();

    client.on("StasisStart", stasisStart);
    client.on("StasisEnd", stasisEnd);

    console.log(`Registering aria Stasis application`);
    client.start("aria");
  }

  console.log("* Initializing Aria Twiml actions. *");
  Object.keys(twimlActions).forEach(key => {
    console.log(` - ${key}`);
  });

  // connect to the local Asterisk server
  // TODO: validate config values
  // ari.connect(ariaConfig.asterisk, ariaConfig.username, ariaConfig.password, clientLoaded)

  console.log(
    `Attempting to Instantiate Aria Twiml on ${ariaConfig.asterisk} | user: ${ariaConfig.username}`
  );

  ari
    .connect(
      ariaConfig.asterisk,
      ariaConfig.username,
      ariaConfig.password,
      clientLoaded
    )
    .then(function(ari) {
      console.log(
        `Connected to Aria Twiml on ${ariaConfig.asterisk} | user: ${ariaConfig.username}`
      );
      ari.asterisk
        .getInfo()
        .then(function(asteriskinfo) {
          console.log(asteriskinfo);
        })
        .catch(function(err) {});
    })
    .catch(function(err) {
      console.log(`Error connecting to ARI is '${err}'`);
    });
})();