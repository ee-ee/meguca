/*
Populates and stores the core state of the server, including generated tempates
*/

'use strict';

// Some hot configs need to be be available when common/ is required
var HOT = exports.hot = require('../config/hot').hot;

var _ = require('underscore'),
	async = require('async'),
	common = require('../common'),
	config = require('../config'),
	crypto = require('crypto'),
	fs = require('fs'),
	hooks = require('../util/hooks'),
	lang = require('../lang'),
	options = require('../common/options'),
	path = require('path'),
	vm = require('vm');

_.templateSettings = {
	interpolate: /\{\{(.+?)}}/g
};

exports.emitter = new (require('events').EventEmitter);

exports.dbCache = {
	OPs: {},
	opTags: {},
	threadSubs: {},
	YAKUMAN: 0,
	funThread: 0,
	addresses: {},
	ranges: {}
};

var RES = exports.resources = {};
exports.clientHotConfig = {};
exports.clientConfigHash = '';
exports.clients = {};
exports.clientsByIP = {};

const clientConfig = exports.clientConfig = _.pick(config,
	'USE_WEBSOCKETS', 'SOCKET_PATH', 'SOCKET_URL', 'DEBUG', 'READ_ONLY',
	'IP_TAGGING', 'RADIO', 'PYU', 'BOARDS', 'LANGS', 'DEFAULT_LANG',
	'READ_ONLY_BOARDS', 'WEBM', 'UPLOAD_URL', 'MEDIA_URL',
	'SECONDARY_MEDIA_URL', 'THUMB_DIMENSIONS', 'PINKY_DIMENSIONS',
	'SPOILER_IMAGES', 'IMAGE_HATS', 'ASSETS_DIR', 'RECAPTCHA_PUBLIC_KEY',
	'LOGIN_KEYWORD', 'STAFF_BOARD'
);

function reload_hot_config(cb) {
	fs.readFile('./config/hot.js', 'UTF-8', function (err, js) {
		if (err)
			cb(err);
		var hot = {};
		try {
			vm.runInNewContext(js, hot);
		}
		catch (e) {
			return cb(e);
		}
		if (!hot || !hot.hot)
			return cb('Bad hot config.');

		// Overwrite the original object just in case
		for (let key in HOT) {
			delete HOT[key];
		}
		_.extend(HOT, hot.hot);

		// Pass some of the config variables to the client
		let clientHot = exports.clientHotConfig = _.pick(HOT,
			'ILLYA_DANCE', 'EIGHT_BALL', 'THREADS_PER_PAGE',
			'ABBREVIATED_REPLIES', 'SUBJECT_MAX_LENGTH', 'EXCLUDE_REGEXP',
			'staff_aliases', 'SAGE_ENABLED', 'THREAD_LAST_N', 'DEFAULT_CSS'
		);

		HOT.CLIENT_CONFIG = JSON.stringify(clientConfig);
		HOT.CLIENT_HOT = JSON.stringify(clientHot);
		// Hash the hot configuration
		exports.clientConfigHash = HOT.CLIENT_CONFIG_HASH
			= hashString(JSON.stringify(clientHot));

		hooks.trigger('reloadHot', HOT, cb);
	});
}

function hashString(string) {
	return crypto.createHash('MD5').update(string).digest('hex');
}

function reloadModClient(cb) {
	async.parallel(
		{
			modJs: readFile('state', 'mod.js'),
			modSourcemap: readFile('state', 'mod.js.map')
		},
		function (err, files) {
			if (err)
				return cb(err);
			_.extend(RES, files);
			cb();
		}
	);
}

// Read JS bundles and generate MD5 hashes
function hashFile(file, cb) {
	let stream = fs.createReadStream(file),
		hash = crypto.createHash('md5');
	stream.once('error', cb);
	stream.on('data', hash.update.bind(hash));
	stream.once('end', function() {
		cb(null, hash.digest('hex'));
	});
}

function hashVendor(cb) {
	hashFile('./www/js/vendor.js', function(err, hash) {
		if (err)
			return cb(err);
		HOT.vendor_hash = hash;
		cb();
	});
}

// Hashes all client bundles into a central hash
function hashClient(cb) {
	let bundles = [
		'./www/js/client.js',
		'./www/js/loader.js',
		'./www/js/login.js',
		'./www/js/setup.js'
	];
	const langs = config.LANGS;
	for (let i = 0, l = langs.length; i < l; i++) {
		bundles.push(`./www/js/lang/${langs[i]}.js`);
	}
	hashFiles('client_hash', bundles, cb);
}

// Produce one hash from the array of files. We don't really need a hash
// for each file, so centralisation reduces bloat and we can later use
// this for version comparison.
function hashFiles(property, files, cb) {
	async.map(files, hashFile, function(err, hashes) {
		if (err)
			return cb(err);
		HOT[property] = hashString(hashes.join(''));
		cb();
	});
}

function hashCSS(cb) {
	fs.readdir('./www/css/', function(err, files) {
		if (err)
			return cb(err);
		let css = [];
		for (let i = 0, l = files.length; i < l; i++) {
			const file = files[i];
			if (file.endsWith('.css'))
				css.push(`./www/css/${file}`);
		}
		hashFiles('css_hash', css, cb);
	})
}

function reload_resources(cb) {
	read_templates(function (err, tmpls) {
		if (err)
			return cb(err);
		_.extend(RES, expand_templates(tmpls));
		cb();
	});
}

function read_templates(cb) {
	async.parallel({
		index: readFile('tmpl', 'index.html'),
		notFound: readFile('www', '404.html'),
		serverError: readFile('www', '50x.html')
	}, cb);
}

function readFile(dir, file) {
	return fs.readFile.bind(fs, path.join(dir, file), 'UTF-8');
}

function expand_templates(res) {
	let templateVars = _.clone(HOT);
	_.extend(templateVars, config);
	templateVars.NAVTOP = make_navigation_html();
	templateVars.FAQ = build_FAQ(templateVars.FAQ);
	// Format info banner
	if (templateVars.BANNERINFO)
		templateVars.BANNERINFO = `&nbsp;&nbsp;[${templateVars.BANNERINFO}]`;

	let ex = {
		notFoundHtml: res.notFound,
		serverErrorHtml: res.serverError
	};

	// Build index templates for each language
	const langs = config.LANGS;
	for (let i = 0, l = langs.length; i < l; i++) {
		indexTemplate(langs[i], templateVars, res.index, ex);
	}
	return ex;
}

function indexTemplate(ln, vars, template, ex) {
	let languagePack = lang[ln];
	vars = _.clone(vars);
	vars.lang = ln;
	// Inject the localised strings
	_.extend(vars, languagePack.tmpl, languagePack.common);
	vars.schedule_modal = build_schedule(vars.SCHEDULE,
		languagePack.show_seconds
	);
	// Build localised options panel
	vars.options_panel = buildOptions(languagePack.opts);

	const html = injectVars(template, vars);
	ex['indexTmpl-' + ln] = html.tmpl;
	ex['indexHash-' + ln] = hashString(html.src).slice(0, 8);
}

function injectVars(template, vars) {
	let expanded = _.template(template)(vars);
	return {
		// Split on points, that will be dinamically inserted into by
		// ../render
		tmpl: expanded.split(/\$[A-Z]+/),
		src: expanded
	};
}

function build_schedule(schedule, showSeconds){
	const filler = ['drink & fap', 'fap & drink', 'tea & keiki'];
	let table = common.parseHTML
		`<table>
			<span id="UTCClock">
				<b title="${showSeconds}"></b>
				<hr>
			</span>`;
	for (let i = 0, l = schedule.length; i < l; i += 3) {
		let day = schedule[i],
			plans = schedule[i + 1],
			time = schedule[i + 2];
		// Fill empty slots
		if (!plans)
			plans = common.random(filler);
		if (!time)
			time = 'all day';
		table += common.parseHTML
			`<tr>
				<td>
					<b>${day}&nbsp;&nbsp;</b>
				</td>
				<td>${plans}&nbsp;&nbsp;</td>
				<td>${time}</td>
			</tr>`;
	}
	table += '</table>';
	return table;
}

function build_FAQ(faq) {
	if (faq.length <= 0)
		return;
	let list = '<ul>';
	for (let i = 0, l = faq.length; i < l; i++) {
		list += `<li>${faq[i]}</li>`;
	}
	list += '</ul>';
	return list;
}

function make_navigation_html() {
	let bits = '<b id="navTop">[';
	// Actual boards
	const BOARDS = config.BOARDS,
		PB = config.PSUEDO_BOARDS;
	for (let i = 0, l = BOARDS.length; i < l; i++) {
		let board = BOARDS[i];
		if (board == config.STAFF_BOARD)
			continue;
		if (i > 0)
			bits += ' / ';
		bits += `<a href="../${board}/" class="history">${board}</a>`;
	}
	// Add custom URLs to board navigation
	for (let i = 0, l = PB.length; i < l; i++) {
		let item = PB[i];
		bits += ` / <a href="${item[1]}">${item[0]}</a>`;
	}
	bits += ']</b>';
	return bits;
}

// Hardcore pornography
function buildOptions(lang) {
	let html = common.parseHTML
		`<div class="bmodal" id="options-panel">
			<ul class="option_tab_sel">`;
	const tabs = lang.tabs;
	// Render tab butts
	for (let i = 0, l = tabs.length; i < l; i++) {
		html += `<li><a data-content="tab-${i}"`;
		// Highlight the first tabButt by default
		if (i === 0)
			html += ' class="tab_sel"';
		html += `>${tabs[i]}</a></li>`;
	}
	html += '</ul><ul class="option_tab_cont">';
	for (let i = 0, l = tabs.length; i < l; i++) {
		let tab = tabs[i];
		let opts = _.filter(options, function(opt) {
			/*
			 * Pick the options for this specific tab. Don't know why we have
			 * undefineds inside the array, but we do.
			 */
			if (!opt || opt.tab != i)
				return false;
			// Option should not be loaded, because of server-side configs
			return !(opt.load !== undefined && !opt.load);
		});
		html += `<li class="tab-${i}`;
		// Show the first tab by default
		if (i === 0)
			html += ' tab_sel';
		html += '">';
		// Render the actual options
		for (let i = 0, l = opts.length; i < l; i++) {
			html += renderOption(opts[i], lang);
		}
		// Append hidden post reset, Export and Import links to first tab
		if (i === 0)
			html += renderExtras(lang);
		html += '</li>';
	}
	html += '</ul></div>';
	return html;
}

function renderOption(opt, lang) {
	let html = '';
	const isShortcut = opt.type == 'shortcut',
		isList = opt.type instanceof Array,
		isCheckbox = opt.type == 'checkbox' || opt.type === undefined,
		isNumber = opt.type == 'number',
		isImage = opt.type == 'image';
	if (isShortcut)
		html += 'Alt+';
	if (!isList) {
		html += '<input';
		if (isCheckbox || isImage)
			html += ` type="${(isCheckbox ? 'checkbox' : 'file')}"`;
		if (isNumber)
			html += ' style="width: 4em;" maxlength="4"';
		else if (isShortcut)
			html += ' maxlength="1"';
	}
	else
		html += '<select';
	// Custom localisation functions
	let title, label;
	if (opt.lang) {
		title = lang[opt.lang][1](opt.id);
		label = lang[opt.lang][0](opt.id);
	}
	else {
		title = lang[opt.id][1];
		label = lang[opt.id][0];
	}
	html += ` id="${opt.id}" title="${title}">`;

	if (isList) {
		const items = opt.type;
		for (let i = 0, l = items.length; i < l; i++) {
			let item = items[i];
			html += `<option value="${item}">${lang[item] || item}</option>`;
		}
		html += '</select>';
	}
	html += `<label for="${opt.id}" title="${title}">${label}</label><br>`;
	return html;
}

function renderExtras(lang) {
	let html = '<br>';
	const links = ['export', 'import', 'hidden'];
	for (let i = 0, l = links.length; i < l; i++) {
		const id = links[i],
			ln = lang[id];
		html += `<a id="${id}" title="${ln[1]}">${ln[0]}</a> `;
	}
	// Hidden file input for uploading the JSON
	html += common.parseHTML
		`<input type="file"
			style="display: none;"
			id="importSettings"
			name="Import Settings"
		>
		</input>`;
	return html;
}

function reload_hot_resources (cb) {
	async.series([
		reload_hot_config,
		reloadModClient,
		hashVendor,
		hashCSS,
		hashClient,
		reload_resources
	], cb);
}
exports.reload_hot_resources = reload_hot_resources;
