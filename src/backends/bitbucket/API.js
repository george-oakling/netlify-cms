import LocalForage from "localforage";
import { Base64 } from "js-base64";
import FormData from "form-data";
import AssetProxy from "ValueObjects/AssetProxy";
import { APIError } from "ValueObjects/errors";
import { SIMPLE } from "Constants/publishModes";

export default class API {
  constructor(config) {
    this.api_root = config.api_root || "https://api.bitbucket.org/2.0";
    this.token = config.token || false;
    this.branch = config.branch || "master";
    this.repo = config.repo || "";
    this.repoURL = `/repositories/${ this.repo }`;
  }

  user() {
    return this.request("/user");
  }
  
  hasWriteAccess(user) {
    return this.request(`/repositories/${ this.repo }`).then((r) => {
      console.log(r);
      return typeof r === 'object';
    });
  }

  requestHeaders(headers = {}) {
    const baseHeader = {
      "Content-Type": "application/json",
      ...headers,
    };

    if (this.token) {
      baseHeader.Authorization = `Bearer ${ this.token }`;
      return baseHeader;
    }

    return baseHeader;
  }

  formRequestHeaders(headers = {}) {
    const baseHeader = {
      ...headers,
    };

    if (this.token) {
      baseHeader.Authorization = `Bearer ${ this.token }`;
      return baseHeader;
    }

    return baseHeader;
  }

  parseJsonResponse(response) {
    return response.json().then((json) => {
      if (!response.ok) {
        return Promise.reject(json);
      }

      return json;
    });
  }

  urlFor(path, options) {
    const cacheBuster = new Date().getTime();
    const params = [`ts=${cacheBuster}`];
    if (options.params) {
      for (const key in options.params) {
        params.push(`${ key }=${ encodeURIComponent(options.params[key]) }`);
      }
    }
    if (params.length) {
      path += `?${ params.join("&") }`;
    }
    return this.api_root + path;
  }

  request(path, options = {}) {
    const headers = this.requestHeaders(options.headers || {});
    const url = this.urlFor(path, options);
    let responseStatus;
    return fetch(url, { ...options, headers }).then((response) => {
      responseStatus = response.status;
      const contentType = response.headers.get("Content-Type");
      if (contentType && contentType.match(/json/)) {
        return this.parseJsonResponse(response);
      }
      return response.text();
    })
    .catch((error) => {
      throw new APIError(error.message, responseStatus, 'Bitbucket');
    });
  }

  //formrequest uses different headers for a form request vs normal json request
  formRequest(path, options = {}) {
    const headers = this.formRequestHeaders(options.headers || {});
    const url = this.urlFor(path, options);
    let responseStatus;
    return fetch(url, { ...options, headers }).then((response) => {
      responseStatus = response.status;
      const contentType = response.headers.get("Content-Type");
      if (contentType && contentType.match(/json/)) {
        return this.parseJsonResponse(response);
      }
      return response.text();
    })
    .catch((error) => {
      throw new APIError(error.message, responseStatus, 'Bitbucket');
    });
  }

  readFile(path, sha, branch = this.branch) {
    const cache = sha ? LocalForage.getItem(`gh.${ sha }`) : Promise.resolve(null);
    return cache.then((cached) => {
      if (cached) { return cached; }

      return this.request(`${ this.repoURL }/src/${ branch }/${ path }`, {
        cache: "no-store",
      }).then((result) => {
        if (sha) {
          LocalForage.setItem(`gh.${ sha }`, result);
        }
        return result;
      });
    });
  }

  listFiles(path, alreadyAssigned) {
    let nextUrl;
    if (!alreadyAssigned) {
      alreadyAssigned = [];
    }
    return this.request(`${ this.repoURL }/src/${ this.branch }/${ path }`, {})
    .then(files => {
      if (!Array.isArray(files.values)) {
        throw new Error(`Cannot list files, path ${path} is not a directory`);
      }
      return files;
    })

    .then(files => {
      if(typeof files.next !== 'undefined') {
        nextUrl = files.next.replace(this.api_root, '');
        nextUrl = nextUrl.replace(`${ this.repoURL }/src/${ this.branch }/`, '');
        return this.listFiles(nextUrl, alreadyAssigned.concat(files.values));
      }
      return alreadyAssigned.concat(files.values);
    })
    .then(files => {
      return files.filter(file => file.type === "commit_file")
    })
  }

  persistFiles(entry, mediaFiles, options) {
    const uploadPromises = [];
    const files = mediaFiles.concat(entry);

    files.forEach((file) => {
      if (file.uploaded) { return; }
      uploadPromises.push(this.uploadBlob(file));
    });

    return Promise.all(uploadPromises).then(() => {
      if (!options.mode || (options.mode && options.mode === SIMPLE)) {
        return this.getBranch();
      }
    });
  }

  deleteFile(path, message, options={}) {
    const branch = options.branch || this.branch;

    let formData = new FormData();
    formData.append('files', path);
    if (message && message != "") {
      formData.append('message', message) ;
    }
    return this.formRequest(`${ this.repoURL }/src`, {
      method: 'POST',
      body: formData
    });
  }

  getBranch(branch = this.branch) {
    return this.request(`${ this.repoURL }/refs/branches/${ encodeURIComponent(branch) }`);
  }

  uploadBlob(item) {
    const content = item instanceof AssetProxy ? item.toBlob() : Promise.resolve(item.raw);

    return content.then(contentBase64 => {
      let formData = new FormData();
      formData.append(item.path, contentBase64);

      this.formRequest(`${ this.repoURL }/src`, {
        method: 'POST',
        body: formData
      }).then((response) => {
        //item.sha = response.sha; //todo: get commit sha from bitbucket?
        item.uploaded = true;
        return item;
      })
    });
  }
}
