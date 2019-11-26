#!/usr/bin/node

/****************************************************************************************

	Aria entry point
	
	This includes the list of Node modules to include. It also creates a few top-level
	variables used throughout the application. This must be concatenated first when
	generating the application. (The grunt configuration currently does this.)
	
****************************************************************************************/
var fs = require("fs");
var url = require("url");
var md5 = require("md5");
var http = require('http');
var path = require("path");
var util = require("util");
var redis = require("redis");
var flite = require("flite");
var parser = require("xmldoc");
var uuid = require('node-uuid');
var ari = require("ari-client");
var express = require("express");
var fetch = require("node-fetch");
fetch.Promise = require("bluebird");
var download = require("download");
var formdata = require("form-data");

var twimlActions = {};
var ariaConfig = {};
var rc = redis.createClient();

