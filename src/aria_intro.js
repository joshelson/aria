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
import http from 'http';
import path from "path";
import util from "util";
import redis from "redis";
import flite from "flite";
import parser from "xmldoc";
import uuid from 'node-uuid';
import ari from "ari-client";
import express from "express";
import fetch from "node-fetch";
fetch.Promise = require("bluebird");
import download from "download";
import formdata from "form-data";

const twimlActions = {};
const ariaConfig = {};
const rc = redis.createClient();

