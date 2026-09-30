"""Supervised, ordered serve/play boundaries within fixed rally intervals.

Learn phase timing from training-site annotations instead of interpreting the
Huji student's serve-like pose as proof that an entire exchange is a serve.
No fixed maximum serve duration or mandatory serve is imposed.
"""
from __future__ import annotations

import numpy as np

from .calibration import features
from .hierarchical import phase_labels


def context(raw, calibrated, fps, intervals):
    base = np.column_stack([features(raw, fps), calibrated])
    result = []
    for start, end in intervals:
        elapsed = (np.arange(end - start) + .5) / fps
        duration = (end - start) / fps
        fraction = elapsed / duration
        timing = np.column_stack([np.log1p(elapsed), np.log1p(duration - elapsed),
                                  fraction, fraction**2, np.full(end-start, np.log1p(duration))])
        result.append(np.column_stack([base[start:end], timing]))
    return result


def fit(sequences, probabilities, intervals, regularization=.03):
    import torch
    torch.set_num_threads(4)
    xs, ys, sites = [], [], []
    names = sorted({s['site'] for s in sequences})
    for s, q, bounds in zip(sequences, probabilities, intervals):
        for (start, end), x in zip(bounds, context(s['scores'], q, s['fps'], bounds)):
            indices = np.arange(0, end-start, max(1, round(s['fps']/10)))
            target = s['truth'][start:end]
            indices = indices[np.isin(target[indices], [0, 1])]
            if not len(indices):
                continue
            xs.append(x[indices]); ys.append(target[indices])
            sites.extend([names.index(s['site'])] * len(indices))
    x, y, site = np.concatenate(xs), np.concatenate(ys), np.asarray(sites)
    if set(y.tolist()) != {0,1}:
        raise ValueError('Phase fit requires reviewed serve and play examples')
    weights = 1 / np.bincount(site)[site]; weights /= weights.sum()
    mean = (x*weights[:,None]).sum(0)
    scale = np.maximum(np.sqrt((((x-mean)**2)*weights[:,None]).sum(0)), .03)
    tensor = torch.tensor((x-mean)/scale, dtype=torch.float64)
    target = torch.tensor(y, dtype=torch.long)
    weight = torch.tensor(weights, dtype=torch.float64)
    coef = torch.zeros((x.shape[1],2),dtype=torch.float64,requires_grad=True)
    bias = torch.zeros(2,dtype=torch.float64,requires_grad=True)
    opt = torch.optim.LBFGS([coef,bias],max_iter=100,tolerance_grad=1e-7,line_search_fn='strong_wolfe')
    def closure():
        opt.zero_grad()
        loss=(torch.nn.functional.cross_entropy(tensor@coef+bias,target,reduction='none')*weight).sum()+regularization*coef.square().sum()/2
        loss.backward();return loss
    opt.step(closure)
    return {'type':'ordered_rally_phase_v1','mean':mean.tolist(),'scale':scale.tolist(),
            'coefficients':coef.detach().numpy().tolist(),'bias':bias.detach().numpy().tolist(),
            'regularization':regularization,'fit_sites':names,'fit_frames':len(y),'switch_cost':.15}


def apply(labels, raw, calibrated, fps, intervals, model):
    if model['type'] != 'ordered_rally_phase_v1':
        raise ValueError('Unsupported phase boundary model')
    output = labels.copy()
    probabilities = calibrated.copy()
    for (start,end), x in zip(intervals,context(raw,calibrated,fps,intervals)):
        logits = (x-model['mean'])/model['scale']@np.asarray(model['coefficients'])+model['bias']
        logits -= logits.max(1,keepdims=True)
        p = np.exp(logits);p /= p.sum(1,keepdims=True)
        phase = np.column_stack([p,np.zeros(len(p))])
        output[start:end] = phase_labels(phase,fps,model['switch_cost'],'ordered')
        probabilities[start:end] = phase
    return output, probabilities
